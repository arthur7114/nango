import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Err, Ok } from '@nangohq/utils';

import { ProxyServiceError } from '../../../../services/proxy.service.js';
import { PublicMcpError } from '../../../mcp/utils.js';
import { buildSessionTools } from '../sessionServer.js';
import { RemoteToolResult } from '../sessionTool.js';

import type { ProxyServiceRequest, ProxyServiceResponse } from '../../../../services/proxy.service.js';
import type { AgentSessionMcpContext } from '../sessionTool.js';
import type { AgentSession, AgentSessionCompiledToolset, DBEnvironment, DBTeam } from '@nangohq/types';
import type { Result } from '@nangohq/utils';

const request = vi.fn();
vi.mock('../../../../services/proxy.service.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    default: { request: (...args: unknown[]) => request(...args) }
}));

const { executeSessionTool } = await import('./execute.js');

const TOOLSET: AgentSessionCompiledToolset = {
    'linear-mcp': {
        provider: 'linear-mcp',
        pinned: [],
        searchable: [{ name: 'list_issues', description: 'List issues', mcp: { inputSchema: { type: 'object' } } }],
        mcpServer: 'available'
    }
};

function context(): AgentSessionMcpContext {
    const session: AgentSession = {
        id: 'session-1',
        environmentId: 1,
        accountId: 1,
        resolvedConnections: {
            'linear-mcp': { integrationId: 'linear-mcp', provider: 'linear-mcp', connectionId: 'linear-acme', internalConnectionId: 10, configId: 20 }
        },
        compiledToolset: TOOLSET,
        metaTools: { nangoToolSearch: true, nangoExecute: true, nangoProxy: false, nangoCreateConnection: { enabled: false, tags: {} } },
        expiresAt: new Date(),
        endedAt: null,
        endedReason: null,
        createdAt: new Date(),
        updatedAt: new Date()
    };

    return { account: { id: 1 } as DBTeam, environment: { id: 1 } as DBEnvironment, plan: null, session, callable: buildSessionTools(session).callable };
}

function response({ status = 200, body = '', headers = {} }: { status?: number; body?: string; headers?: Record<string, string> }) {
    const value: ProxyServiceResponse = {
        outcome: status >= 400 ? 'upstream_error' : 'success',
        status,
        headers: { 'content-type': 'application/json', ...headers },
        body: Readable.from([Buffer.from(body)]),
        complete: () => Promise.resolve()
    };
    return { logCtx: { id: 'log-1' }, result: Ok(value) };
}

/** Answers the handshake, then hands `onCall` every later JSON-RPC request. */
function mcpServer(onCall: (message: { id?: number; method: string; params?: unknown }) => ReturnType<typeof response>) {
    request.mockImplementation((params: ProxyServiceRequest) => {
        const message = params.body as { id?: number; method: string; params?: unknown } | undefined;
        if (params.method === 'DELETE' || !message?.id) {
            return Promise.resolve(response({ status: 202 }));
        }
        if (message.method === 'initialize') {
            return Promise.resolve(
                response({
                    body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }),
                    headers: { 'mcp-session-id': 'remote-session' }
                })
            );
        }
        return Promise.resolve(onCall(message));
    });
}

async function execute(input?: unknown): Promise<Result<unknown>> {
    return await executeSessionTool({
        metaTool: 'nango_execute',
        integrationId: 'linear-mcp',
        toolName: 'list_issues',
        pinned: false,
        input,
        context: context()
    });
}

function codeOf(result: Result<unknown>): string | undefined {
    if (result.isOk()) {
        expect.fail('Expected an error');
    }
    return result.error instanceof PublicMcpError ? result.error.code : undefined;
}

describe('executeSessionTool on an MCP server tool', () => {
    beforeEach(() => {
        request.mockReset();
    });

    it('calls the tool through the proxy and passes its result through', async () => {
        const result = { content: [{ type: 'text', text: 'ENG-1' }], structuredContent: { issues: ['ENG-1'] } };
        mcpServer((message) => response({ body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) }));

        const executed = await execute({ team: 'ENG' });

        expect(executed.unwrap()).toEqual(new RemoteToolResult(result));
        const call = request.mock.calls
            .map(([params]) => params as ProxyServiceRequest)
            .find((params) => (params.body as { method?: string })?.method === 'tools/call');
        expect(call).toMatchObject({
            endpoint: '/mcp',
            integrationId: 'linear-mcp',
            connectionId: 'linear-acme',
            headers: { 'mcp-session-id': 'remote-session' },
            body: { method: 'tools/call', params: { name: 'list_issues', arguments: { team: 'ENG' } } },
            actor: { kind: 'session', id: 'session-1' },
            activityLogId: 'log-1'
        });
        expect(request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'DELETE' });
    });

    it('reads a result sent as an event stream', async () => {
        const result = { content: [{ type: 'text', text: 'none' }], isError: true };
        mcpServer((message) =>
            response({
                body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
                headers: { 'content-type': 'text/event-stream' }
            })
        );

        expect((await execute()).unwrap()).toEqual(new RemoteToolResult(result));
    });

    it('rejects a result that is not valid MCP', async () => {
        mcpServer((message) => response({ body: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: 'nope' } }) }));

        expect(codeOf(await execute())).toBe('provider_error');
    });

    it('reports a JSON-RPC error as a failed tool', async () => {
        mcpServer((message) => response({ body: JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown team' } }) }));

        expect(codeOf(await execute())).toBe('tool_failed');
    });

    it('asks for a reconnect when the server refuses the credentials', async () => {
        mcpServer(() => response({ status: 401 }));

        expect(codeOf(await execute())).toBe('integration_not_connected');
    });

    it('maps a proxy failure the way nango_proxy does', async () => {
        request.mockResolvedValue({
            logCtx: undefined,
            result: Err(new ProxyServiceError({ code: 'connection_not_found', message: 'Connection not found', status: 404 }))
        });

        expect(codeOf(await execute())).toBe('integration_not_connected');
    });

    it('rejects an input that is not an object before calling the server', async () => {
        expect(codeOf(await execute(['ENG']))).toBe('invalid_input');
        expect(request).not.toHaveBeenCalled();
    });
});
