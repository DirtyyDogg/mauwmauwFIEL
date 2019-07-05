/********************************************************************************
 * Copyright (C) 2018 Red Hat, Inc. and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/
import { DocumentsMain, MAIN_RPC_CONTEXT, DocumentsExt } from '../../api/plugin-api';
import { UriComponents } from '../../common/uri-components';
import { EditorsAndDocumentsMain } from './editors-and-documents-main';
import { DisposableCollection, Disposable } from '@theia/core';
import { MonacoEditorModel } from '@theia/monaco/lib/browser/monaco-editor-model';
import { RPCProtocol } from '../../api/rpc-protocol';
import { EditorModelService } from './text-editor-model-service';
import { createUntitledResource } from './editor/untitled-resource';
import { EditorManager, EditorOpenerOptions } from '@theia/editor/lib/browser';
import URI from '@theia/core/lib/common/uri';
import CodeURI from 'vscode-uri';
import { ApplicationShell, Saveable } from '@theia/core/lib/browser';
import { TextDocumentShowOptions } from '../../api/model';
import { Range } from 'vscode-languageserver-types';
import { OpenerService } from '@theia/core/lib/browser/opener-service';
import { Reference } from '@theia/core/lib/common/reference';
import { dispose } from '../../common/disposable-util';

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
export class ModelReferenceCollection {

    private data = new Array<{ length: number, dispose(): void }>();
    private length = 0;

    constructor(
        private readonly maxAge: number = 1000 * 60 * 3,
        private readonly maxLength: number = 1024 * 1024 * 80
    ) { }

    dispose(): void {
        this.data = dispose(this.data) || [];
    }

    add(ref: Reference<MonacoEditorModel>): void {
        const length = ref.object.textEditorModel.getValueLength();
        // tslint:disable-next-line: no-any
        let handle: any;
        let entry: { length: number, dispose(): void };
        const _dispose = () => {
            const idx = this.data.indexOf(entry);
            if (idx >= 0) {
                this.length -= length;
                ref.dispose();
                clearTimeout(handle);
                this.data.splice(idx, 1);
            }
        };
        handle = setTimeout(_dispose, this.maxAge);
        entry = { length, dispose: _dispose };

        this.data.push(entry);
        this.length += length;
        this.cleanup();
    }

    private cleanup(): void {
        while (this.length > this.maxLength) {
            this.data[0].dispose();
        }
    }
}

export class DocumentsMainImpl implements DocumentsMain {

    private proxy: DocumentsExt;
    private toDispose = new DisposableCollection();
    private modelToDispose = new Map<string, Disposable>();
    private modelIsSynced = new Map<string, boolean>();
    private modelService: EditorModelService;
    private modelReferenceCache = new ModelReferenceCollection();

    protected saveTimeout = 1750;

    constructor(
        editorsAndDocuments: EditorsAndDocumentsMain,
        modelService: EditorModelService,
        rpc: RPCProtocol,
        private editorManager: EditorManager,
        private openerService: OpenerService,
        private shell: ApplicationShell
    ) {
        this.proxy = rpc.getProxy(MAIN_RPC_CONTEXT.DOCUMENTS_EXT);
        this.modelService = modelService;

        this.toDispose.push(editorsAndDocuments.onDocumentAdd(documents => documents.forEach(this.onModelAdded, this)));
        this.toDispose.push(editorsAndDocuments.onDocumentRemove(documents => documents.forEach(this.onModelRemoved, this)));
        this.toDispose.push(modelService.onModelModeChanged(this.onModelChanged, this));
        this.toDispose.push(this.modelReferenceCache);

        this.toDispose.push(modelService.onModelSaved(m => {
            this.proxy.$acceptModelSaved(m.textEditorModel.uri);
        }));
        this.toDispose.push(modelService.onModelWillSave(onWillSaveModelEvent => {
            onWillSaveModelEvent.waitUntil(new Promise<monaco.editor.IIdentifiedSingleEditOperation[]>(async (resolve, reject) => {
                setTimeout(() => reject(new Error(`Aborted onWillSaveTextDocument-event after ${this.saveTimeout}ms`)), this.saveTimeout);
                const edits = await this.proxy.$acceptModelWillSave(onWillSaveModelEvent.model.textEditorModel.uri, onWillSaveModelEvent.reason, this.saveTimeout);
                const transformedEdits = edits.map((edit): monaco.editor.IIdentifiedSingleEditOperation =>
                    ({
                        range: monaco.Range.lift(edit.range),
                        text: edit.text!,
                        forceMoveMarkers: edit.forceMoveMarkers
                    }));
                resolve(transformedEdits);
            }));
        }));
        this.toDispose.push(modelService.onModelDirtyChanged(m => {
            this.proxy.$acceptDirtyStateChanged(m.textEditorModel.uri, m.dirty);
        }));
    }

    dispose(): void {
        this.modelToDispose.forEach(val => val.dispose());
        this.modelToDispose = new Map();
        this.toDispose.dispose();
    }

    private onModelChanged(event: { model: MonacoEditorModel, oldModeId: string }): void {
        const modelUrl = event.model.textEditorModel.uri;
        if (!this.modelIsSynced.get(modelUrl.toString())) {
            return;
        }

        this.proxy.$acceptModelModeChanged(modelUrl, event.oldModeId, event.model.languageId);
    }

    private onModelAdded(model: MonacoEditorModel): void {
        const modelUrl = model.textEditorModel.uri;
        this.modelIsSynced.set(modelUrl.toString(), true);
        this.modelToDispose.set(modelUrl.toString(), model.textEditorModel.onDidChangeContent(e => {
            this.proxy.$acceptModelChanged(modelUrl, {
                eol: e.eol,
                versionId: e.versionId,
                changes: e.changes.map(c =>
                    ({
                        text: c.text,
                        range: c.range,
                        rangeLength: c.rangeLength,
                        rangeOffset: 0
                    }))
            }, model.dirty);
        }));

    }

    private onModelRemoved(url: monaco.Uri): void {
        const modelUrl = url.toString();
        if (!this.modelIsSynced.get(modelUrl)) {
            return;
        }

        this.modelIsSynced.delete(modelUrl);
        this.modelToDispose.get(modelUrl)!.dispose();
        this.modelToDispose.delete(modelUrl);
    }

    async $tryCreateDocument(options?: { language?: string; content?: string; }): Promise<UriComponents> {
        const language = options && options.language;
        const content = options && options.content;
        const resource = createUntitledResource(content, language);
        return monaco.Uri.parse(resource.uri.toString());
    }

    async $tryShowDocument(uri: UriComponents, options?: TextDocumentShowOptions): Promise<void> {
        // Removing try-catch block here makes it not possible to handle errors.
        // Following message is appeared in browser console
        //   - Uncaught (in promise) Error: Cannot read property 'message' of undefined.
        try {
            const editorOptions = DocumentsMainImpl.toEditorOpenerOptions(this.shell, options);
            const uriArg = new URI(CodeURI.revive(uri));
            const opener = await this.openerService.getOpener(uriArg, editorOptions);
            await opener.open(uriArg, editorOptions);
        } catch (err) {
            throw new Error(err);
        }
    }

    async $trySaveDocument(uri: UriComponents): Promise<boolean> {
        const widget = await this.editorManager.getByUri(new URI(CodeURI.revive(uri)));
        if (widget) {
            await Saveable.save(widget);
            return true;
        }

        return false;
    }

    async $tryOpenDocument(uri: UriComponents): Promise<boolean> {
        const ref = await this.modelService.createModelReference(new URI(CodeURI.revive(uri)));
        if (ref.object) {
            this.modelReferenceCache.add(ref);
            return true;
        } else {
            ref.dispose();
            return false;
        }
    }

    async $tryCloseDocument(uri: UriComponents): Promise<boolean> {
        const widget = await this.editorManager.getByUri(new URI(CodeURI.revive(uri)));
        if (widget) {
            await Saveable.save(widget);
            widget.close();
            return true;
        }

        return false;
    }

    static toEditorOpenerOptions(shell: ApplicationShell, options?: TextDocumentShowOptions): EditorOpenerOptions | undefined {
        if (!options) {
            return undefined;
        }
        let range: Range | undefined;
        if (options.selection) {
            const selection = options.selection;
            range = {
                start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 },
                end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 }
            };
        }
        /* fall back to side group -> split relative to the active widget */
        let widgetOptions: ApplicationShell.WidgetOptions | undefined = { mode: 'split-right' };
        const viewColumn = options.viewColumn;
        if (viewColumn === undefined || viewColumn === -1) {
            /* active group -> skip (default behaviour) */
            widgetOptions = undefined;
        } else if (viewColumn > 0) {
            const tabBars = shell.mainAreaTabBars;
            const tabBar = tabBars[viewColumn];
            if (tabBar && tabBar.currentTitle) {
                widgetOptions = { ref: tabBar.currentTitle.owner };
            }
        }
        return {
            selection: range,
            mode: options.preserveFocus ? 'reveal' : 'activate',
            preview: options.preview,
            widgetOptions
        };
    }

}
