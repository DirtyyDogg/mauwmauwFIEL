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
import { Emitter } from '@theia/core/lib/common/event';
import { IJSONSchema, IJSONSchemaSnippet } from '@theia/core/lib/common/json-schema';
import { Path } from '@theia/core/lib/common/path';
import { CommunicationProvider } from '@theia/debug/lib/common/debug-model';
import * as theia from '@theia/plugin';
import URI from 'vscode-uri';
import { Breakpoint } from '../../../api/model';
import { DebugExt, DebugMain, PLUGIN_RPC_CONTEXT as Ext, TerminalOptionsExt } from '../../../api/plugin-api';
import { RPCProtocol } from '../../../api/rpc-protocol';
import { DebuggerContribution } from '../../../common';
import { PluginWebSocketChannel } from '../../../common/connection';
import { CommandRegistryImpl } from '../../command-registry';
import { ConnectionExtImpl } from '../../connection-ext';
import { Disposable } from '../../types-impl';
import { resolveDebugAdapterExecutable } from './plugin-debug-adapter-executable-resolver';
import { PluginDebugAdapterSession } from './plugin-debug-adapter-session';
import { connectDebugAdapter, startDebugAdapter } from './plugin-debug-adapter-starter';
import { PluginDebugAdapterTracker } from './plugin-debug-adapter-tracker';
import uuid = require('uuid');

// tslint:disable:no-any

// TODO: rename file to `debug-ext.ts`

/**
 * It is supposed to work at node only.
 */
export class DebugExtImpl implements DebugExt {
    // debug sessions by sessionId
    private sessions = new Map<string, PluginDebugAdapterSession>();

    // providers by type
    private configurationProviders = new Map<string, Set<theia.DebugConfigurationProvider>>();
    private debuggersContributions = new Map<string, DebuggerContribution>();
    private descriptorFactories = new Map<string, theia.DebugAdapterDescriptorFactory>();
    private trackerFactories: [string, theia.DebugAdapterTrackerFactory][] = [];
    private contributionPaths = new Map<string, string>();

    private connectionExt: ConnectionExtImpl;
    private commandRegistryExt: CommandRegistryImpl;

    private proxy: DebugMain;

    private readonly onDidChangeBreakpointsEmitter = new Emitter<theia.BreakpointsChangeEvent>();
    private readonly onDidChangeActiveDebugSessionEmitter = new Emitter<theia.DebugSession | undefined>();
    private readonly onDidTerminateDebugSessionEmitter = new Emitter<theia.DebugSession>();
    private readonly onDidStartDebugSessionEmitter = new Emitter<theia.DebugSession>();
    private readonly onDidReceiveDebugSessionCustomEmitter = new Emitter<theia.DebugSessionCustomEvent>();

    activeDebugSession: theia.DebugSession | undefined;
    activeDebugConsole: theia.DebugConsole;
    breakpoints: theia.Breakpoint[] = [];

    constructor(rpc: RPCProtocol) {
        this.proxy = rpc.getProxy(Ext.DEBUG_MAIN);
        this.activeDebugConsole = {
            append: (value: string) => this.proxy.$appendToDebugConsole(value),
            appendLine: (value: string) => this.proxy.$appendLineToDebugConsole(value)
        };
    }

    /**
     * Sets dependencies.
     */
    assistedInject(connectionExt: ConnectionExtImpl, commandRegistryExt: CommandRegistryImpl) {
        this.connectionExt = connectionExt;
        this.commandRegistryExt = commandRegistryExt;
    }

    /**
     * Registers contributions.
     * @param pluginFolder plugin folder path
     * @param contributions available debuggers contributions
     */
    registerDebuggersContributions(pluginFolder: string, contributions: DebuggerContribution[]): void {
        contributions.forEach((contribution: DebuggerContribution) => {
            this.contributionPaths.set(contribution.type, pluginFolder);
            this.debuggersContributions.set(contribution.type, contribution);
            this.proxy.$registerDebuggerContribution({
                type: contribution.type,
                label: contribution.label || contribution.type
            });
            console.log(`Debugger contribution has been registered: ${contribution.type}`);
        });
    }

    get onDidReceiveDebugSessionCustomEvent(): theia.Event<theia.DebugSessionCustomEvent> {
        return this.onDidReceiveDebugSessionCustomEmitter.event;
    }

    get onDidChangeActiveDebugSession(): theia.Event<theia.DebugSession | undefined> {
        return this.onDidChangeActiveDebugSessionEmitter.event;
    }

    get onDidTerminateDebugSession(): theia.Event<theia.DebugSession> {
        return this.onDidTerminateDebugSessionEmitter.event;
    }

    get onDidStartDebugSession(): theia.Event<theia.DebugSession> {
        return this.onDidStartDebugSessionEmitter.event;
    }

    get onDidChangeBreakpoints(): theia.Event<theia.BreakpointsChangeEvent> {
        return this.onDidChangeBreakpointsEmitter.event;
    }

    addBreakpoints(breakpoints: theia.Breakpoint[]): void {
        this.proxy.$addBreakpoints(breakpoints);
    }

    removeBreakpoints(breakpoints: theia.Breakpoint[]): void {
        this.proxy.$removeBreakpoints(breakpoints);
    }

    startDebugging(folder: theia.WorkspaceFolder | undefined, nameOrConfiguration: string | theia.DebugConfiguration): PromiseLike<boolean> {
        return this.proxy.$startDebugging(folder, nameOrConfiguration);
    }

    registerDebugAdapterDescriptorFactory(debugType: string, factory: theia.DebugAdapterDescriptorFactory): Disposable {
        if (this.descriptorFactories.has(debugType)) {
            throw new Error(`Descriptor factory for ${debugType} has been already registered`);
        }
        this.descriptorFactories.set(debugType, factory);
        return Disposable.create(() => this.descriptorFactories.delete(debugType));
    }

    registerDebugAdapterTrackerFactory(debugType: string, factory: theia.DebugAdapterTrackerFactory): Disposable {
        if (!factory) {
            return Disposable.create(() => { });
        }

        this.trackerFactories.push([debugType, factory]);
        return Disposable.create(() => {
            this.trackerFactories = this.trackerFactories.filter(tuple => tuple[1] !== factory);
        });
    }

    registerDebugConfigurationProvider(debugType: string, provider: theia.DebugConfigurationProvider): Disposable {
        console.log(`Debug configuration provider has been registered: ${debugType}`);
        const providers = this.configurationProviders.get(debugType) || new Set<theia.DebugConfigurationProvider>();
        this.configurationProviders.set(debugType, providers);
        providers.add(provider);

        return Disposable.create(() => {
            // tslint:disable-next-line:no-shadowed-variable
            const providers = this.configurationProviders.get(debugType);
            if (providers) {
                providers.delete(provider);
                if (providers.size === 0) {
                    this.configurationProviders.delete(debugType);
                }
            }
        });
    }

    async $onSessionCustomEvent(sessionId: string, event: string, body?: any): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.onDidReceiveDebugSessionCustomEmitter.fire({ event, body, session });
        }
    }

    async $sessionDidCreate(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.onDidStartDebugSessionEmitter.fire(session);
        }
    }

    async $sessionDidDestroy(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.onDidTerminateDebugSessionEmitter.fire(session);
        }
    }

    async $sessionDidChange(sessionId: string | undefined): Promise<void> {
        this.activeDebugSession = sessionId ? this.sessions.get(sessionId) : undefined;
        this.onDidChangeActiveDebugSessionEmitter.fire(this.activeDebugSession);
    }

    async $breakpointsDidChange(all: Breakpoint[], added: Breakpoint[], removed: Breakpoint[], changed: Breakpoint[]): Promise<void> {
        this.breakpoints = all;
        this.onDidChangeBreakpointsEmitter.fire({ added, removed, changed });
    }

    async $createDebugSession(debugConfiguration: theia.DebugConfiguration): Promise<string> {
        const sessionId = uuid.v4();

        const theiaSession: theia.DebugSession = {
            id: sessionId,
            type: debugConfiguration.type,
            name: debugConfiguration.name,
            customRequest: (command: string, args?: any) => this.proxy.$customRequest(sessionId, command, args)
        };

        const tracker = await this.createDebugAdapterTracker(theiaSession);
        const communicationProvider = await this.createCommunicationProvider(theiaSession, debugConfiguration);

        const debugAdapterSession = new PluginDebugAdapterSession(communicationProvider, tracker, theiaSession);
        this.sessions.set(sessionId, debugAdapterSession);

        const connection = await this.connectionExt!.ensureConnection(sessionId);
        debugAdapterSession.start(new PluginWebSocketChannel(connection));

        return sessionId;
    }

    async $terminateDebugSession(sessionId: string): Promise<void> {
        const debugAdapterSession = this.sessions.get(sessionId);
        if (debugAdapterSession) {
            await debugAdapterSession.stop();
            this.sessions.delete(sessionId);
        }
    }

    async $getSupportedLanguages(debugType: string): Promise<string[]> {
        const contribution = this.debuggersContributions.get(debugType);
        return contribution && contribution.languages || [];
    }

    async $getSchemaAttributes(debugType: string): Promise<IJSONSchema[]> {
        const contribution = this.debuggersContributions.get(debugType);
        return contribution && contribution.configurationAttributes || [];
    }

    async $getConfigurationSnippets(debugType: string): Promise<IJSONSchemaSnippet[]> {
        const contribution = this.debuggersContributions.get(debugType);
        return contribution && contribution.configurationSnippets || [];
    }

    async $getTerminalCreationOptions(debugType: string): Promise<TerminalOptionsExt | undefined> {
        return this.doGetTerminalCreationOptions(debugType);
    }

    async doGetTerminalCreationOptions(debugType: string): Promise<TerminalOptionsExt | undefined> {
        return undefined;
    }

    async $provideDebugConfigurations(debugType: string, workspaceFolderUri: string | undefined): Promise<theia.DebugConfiguration[]> {
        let result: theia.DebugConfiguration[] = [];

        const providers = this.configurationProviders.get(debugType);
        if (providers) {
            for (const provider of providers) {
                if (provider.provideDebugConfigurations) {
                    result = result.concat(await provider.provideDebugConfigurations(this.toWorkspaceFolder(workspaceFolderUri)) || []);
                }
            }
        }

        return result;
    }

    async $resolveDebugConfigurations(debugConfiguration: theia.DebugConfiguration, workspaceFolderUri: string | undefined): Promise<theia.DebugConfiguration | undefined> {
        let current = debugConfiguration;

        const providers = this.configurationProviders.get(debugConfiguration.type);
        if (providers) {
            for (const provider of providers) {
                if (provider.resolveDebugConfiguration) {
                    try {
                        const next = await provider.resolveDebugConfiguration(this.toWorkspaceFolder(workspaceFolderUri), current);
                        if (next) {
                            current = next;
                        } else {
                            return current;
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
        }

        return current;
    }

    protected async createDebugAdapterTracker(session: theia.DebugSession): Promise<theia.DebugAdapterTracker> {
        return PluginDebugAdapterTracker.create(session, this.trackerFactories);
    }

    protected async createCommunicationProvider(session: theia.DebugSession, debugConfiguration: theia.DebugConfiguration): Promise<CommunicationProvider> {
        const executable = await this.resolveDebugAdapterExecutable(debugConfiguration);
        const descriptorFactory = this.descriptorFactories.get(session.type);
        if (descriptorFactory) {
            // 'createDebugAdapterDescriptor' is called at the start of a debug session to provide details about the debug adapter to use.
            // These details must be returned as objects of type [DebugAdapterDescriptor](#DebugAdapterDescriptor).
            // Currently two types of debug adapters are supported:
            // - a debug adapter executable is specified as a command path and arguments (see [DebugAdapterExecutable](#DebugAdapterExecutable)),
            // - a debug adapter server reachable via a communication port (see [DebugAdapterServer](#DebugAdapterServer)).
            // If the method is not implemented the default behavior is this:
            //   createDebugAdapter(session: DebugSession, executable: DebugAdapterExecutable) {
            //      if (typeof session.configuration.debugServer === 'number') {
            //         return new DebugAdapterServer(session.configuration.debugServer);
            //      }
            //      return executable;
            //   }
            //  @param session The [debug session](#DebugSession) for which the debug adapter will be used.
            //  @param executable The debug adapter's executable information as specified in the package.json (or undefined if no such information exists).
            const descriptor = await descriptorFactory.createDebugAdapterDescriptor(session, executable);
            if (descriptor) {
                if ('port' in descriptor) {
                    return connectDebugAdapter(descriptor);
                } else {
                    return startDebugAdapter(descriptor);
                }
            }
        }

        if ('debugServer' in debugConfiguration) {
            return connectDebugAdapter({ port: debugConfiguration.debugServer });
        } else {
            if (!executable) {
                throw new Error('It is not possible to provide debug adapter executable.');
            }
            return startDebugAdapter(executable);
        }
    }

    protected async resolveDebugAdapterExecutable(debugConfiguration: theia.DebugConfiguration): Promise<theia.DebugAdapterExecutable | undefined> {
        const { type } = debugConfiguration;
        const contribution = this.debuggersContributions.get(type);
        if (contribution) {
            if (contribution.adapterExecutableCommand) {
                const executable = await this.commandRegistryExt.executeCommand<theia.DebugAdapterExecutable>(contribution.adapterExecutableCommand);
                if (executable) {
                    return executable;
                }
            } else {
                const contributionPath = this.contributionPaths.get(type);
                if (contributionPath) {
                    return resolveDebugAdapterExecutable(contributionPath, contribution);
                }
            }
        }

        throw new Error(`It is not possible to provide debug adapter executable for '${debugConfiguration.type}'.`);
    }

    private toWorkspaceFolder(folder: string | undefined): theia.WorkspaceFolder | undefined {
        if (!folder) {
            return undefined;
        }

        const uri = URI.parse(folder);
        const path = new Path(uri.path);
        return {
            uri: uri,
            name: path.base,
            index: 0
        };
    }
}
