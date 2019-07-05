/********************************************************************************
 * Copyright (C) 2019 Red Hat, Inc. and others.
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

// tslint:disable:no-any

import { Disposable, Event } from '@theia/core/lib/common';
import URI from '@theia/core/lib/common/uri';

export interface ScmProvider extends Disposable {
    readonly id: string;
    readonly label: string;
    readonly rootUri: string;

    readonly acceptInputCommand?: ScmCommand;

    readonly groups: ScmResourceGroup[];
    readonly onDidChange: Event<void>;

    readonly statusBarCommands?: ScmCommand[];
    readonly onDidChangeStatusBarCommands?: Event<ScmCommand[] | undefined>;

    readonly amendSupport?: ScmAmendSupport;
}

export interface ScmResourceGroup extends Disposable {
    readonly id: string;
    readonly label: string;
    readonly resources: ScmResource[];
    readonly hideWhenEmpty?: boolean;

    readonly provider: ScmProvider;
}

export interface ScmResource {
    /** The uri of the underlying resource inside the workspace. */
    readonly sourceUri: URI;
    readonly decorations?: ScmResourceDecorations;
    open(): Promise<void>;

    readonly group: ScmResourceGroup;
}

export interface ScmResourceDecorations {
    icon?: string;
    tooltip?: string;
    source?: string;
    letter?: string;
    color?: string;
}

export interface ScmCommand {
    title: string;
    tooltip?: string;
    command?: string;
}

export interface ScmCommit {
    id: string,  // eg Git sha or Mercurial revision number
    summary: string,
    authorName: string,
    authorEmail: string,
    authorDateRelative: string
}

export interface ScmAmendSupport {
    getInitialAmendingCommits(amendingHeadCommitSha: string, latestCommitSha: string): Promise<ScmCommit[]>
    getMessage(commit: string): Promise<string>;
    reset(commit: string): Promise<void>;
    getLastCommit(): Promise<ScmCommit | undefined>;
}
