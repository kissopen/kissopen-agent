import { randomUUID } from "node:crypto";
import {
    AnthropicBedrockSession,
    BaseProvider,
    BaseSession,
    BedrockBearerTokenCredential,
    ChatCompletionsProvider,
    CodexProvider,
    DeepSeekApiKeyCredential,
    DeepSeekProvider,
    type GenerateCodexImageRequest,
    type GenerateCodexImageResult,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionContext,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
    type SessionUsage,
} from "@kissopen/kissopen-providers";
import type { Context } from "@steve.kite/stdlib";

import type { KissopenServedRoute } from "./kissopenServedModels.js";
import { lightenKissopenImages } from "./lightenKissopenImages.js";

const checkpoint = `Produce a concise continuation checkpoint of the conversation above.
Retain the user's goal, accepted requirements, permissions and restrictions, completed work,
exact relevant paths and identifiers, observed tool results, unresolved errors, and the next
necessary actions. Distinguish verified results from assumptions and unfinished work.
Do not execute tools or continue the task. Do not invent facts or expose credentials.
Write only the checkpoint, in the user's language, within 1500 words.`;

// Codex's transport accepts only encrypted compaction records. KISSOPEN's
// portable checkpoint is ordinary context, not a fabricated encrypted record.
function portableContext(context: SessionContext): SessionContext {
    if (
        !context.messages.some(
            (message) => message.role === "compaction" && !message.encryptedContent,
        )
    )
        return context;
    return {
        ...context,
        messages: context.messages.map((message) =>
            message.role === "compaction" && !message.encryptedContent
                ? {
                      role: "user" as const,
                      content: [
                          {
                              type: "text" as const,
                              text: `Conversation continuation checkpoint (historical context):\n${message.content}`,
                          },
                      ],
                  }
                : message,
        ),
    };
}

/*
How long a call to the KISSOPEN server may keep a conversation waiting.

Codex's own clocks are made for OpenAI: ten minutes for a response to start,
five minutes of silence inside one, and ten retries, each restarting both. A
stalled model pool behind the server therefore held a turn for up to two hours
with nothing on screen. The server gives up on the pool after two minutes
without a response and after 170 seconds of silence inside one, answering with
an error; these limits sit just above those, so the server's error normally
arrives first and a server that stops answering altogether is still noticed.
Three retries keep one stall to about ten minutes before the person is told.
*/
const KISSOPEN_RESPONSE_TIMEOUT_MS = 150_000;
const KISSOPEN_STREAM_IDLE_TIMEOUT_MS = 180_000;
const KISSOPEN_MAX_RETRIES = 3;

// The resource pool supports Responses inference, but not Codex's proprietary
// encrypted compaction. Keep ordinary Codex tools unchanged and use KISSOPEN's
// existing portable text-checkpoint contract only for this configured provider.
/** Models the KISSOPEN server serves from DeepSeek's own API, over Chat Completions. */
function isDeepSeekModel(model: string | undefined): boolean {
    return model?.startsWith("deepseek/") === true;
}

/**
 * Which of the server's APIs a model is called through: the pool's Responses (`ordinary`),
 * DeepSeek's Chat Completions, or — for a model the server serves from an upstream added in its
 * console — the API the server's policy names for it.
 */
type KissopenRoute = "ordinary" | "deepseek" | "chat" | "messages";

/*
The Anthropic client addresses Messages as `{base}/v1/messages`; the server answers them beside
its other agent APIs, at `{base_url}/messages`, so the client's base is the configured one
without its trailing `/v1`.
*/
/*
The conversation a call belongs to, as the Codex path already says it. Services built for coding
agents — OpenCode Go refuses a call without one — route and cache by it; the server passes it on.
*/
function conversationHeaders(conversation: string): Record<string, string> {
    return { "session-id": conversation };
}

function anthropicBase(endpoint: string): string {
    return endpoint.replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

export type KissopenProviderOptions = ConstructorParameters<typeof CodexProvider>[0] & {
    /** What the server's policy says about a model it serves from a console upstream. */
    readonly servedRoute?: (model: string | undefined) => KissopenServedRoute | undefined;
};

export class KissopenProvider extends BaseProvider {
    private readonly provider: CodexProvider;
    /*
     * DeepSeek's models, through the same server and the same device key. The server answers
     * Chat Completions at the same base URL and forwards DeepSeek models to DeepSeek; the
     * Responses path the Codex models take would not carry DeepSeek's thinking and reasoning.
     */
    readonly #deepseek: Promise<DeepSeekProvider | undefined>;
    /** Served models over Chat Completions, through the same server and device key. */
    readonly #chat: ConstructorParameters<typeof ChatCompletionsProvider>[0] | undefined;
    /** Served models over Anthropic Messages, through the same server and device key. */
    readonly #messages: Promise<BedrockBearerTokenCredential | null>;
    readonly #endpoint: string | undefined;
    readonly #retries: number;
    readonly #servedRoute: (model: string | undefined) => KissopenServedRoute | undefined;
    constructor(options: KissopenProviderOptions) {
        super();
        const { resolveInferenceMaxRetries: _live, servedRoute, ...rest } = options;
        this.#servedRoute = servedRoute ?? (() => undefined);
        const retries = Math.min(
            options.inferenceMaxRetries ?? KISSOPEN_MAX_RETRIES,
            KISSOPEN_MAX_RETRIES,
        );
        const apiKey =
            options.credential.name === "codex-api-key"
                ? options.credential.credential.apiKey
                : undefined;
        const endpoint = options.endpoint;
        this.#deepseek =
            apiKey === undefined || endpoint === undefined
                ? Promise.resolve(undefined)
                : DeepSeekApiKeyCredential.tryLoad({ apiKey, env: {} }).then((credential) =>
                      credential === null
                          ? undefined
                          : new DeepSeekProvider({
                                credential,
                                baseUrl: endpoint,
                                responseTimeoutMs: KISSOPEN_RESPONSE_TIMEOUT_MS,
                                streamIdleTimeoutMs: KISSOPEN_STREAM_IDLE_TIMEOUT_MS,
                                inferenceMaxRetries: retries,
                            }),
                  );
        this.provider = new CodexProvider({
            responseTimeoutMs: KISSOPEN_RESPONSE_TIMEOUT_MS,
            streamIdleTimeoutMs: KISSOPEN_STREAM_IDLE_TIMEOUT_MS,
            ...rest,
            inferenceMaxRetries: retries,
        });
        this.#endpoint = endpoint;
        this.#retries = retries;
        this.#chat =
            apiKey === undefined || endpoint === undefined
                ? undefined
                : {
                      apiKey,
                      baseUrl: endpoint,
                      service: "KissOpen",
                      // The server knows the model by the Agent's own name and says how long an
                      // answer it may write; the wire carries both as they are.
                      resolveModel: (model) => {
                          const route = this.#servedRoute(model);
                          return {
                              wireModel: model,
                              ...(route === undefined
                                  ? {}
                                  : { maxTokens: route.max_output_tokens }),
                          };
                      },
                      responseTimeoutMs: KISSOPEN_RESPONSE_TIMEOUT_MS,
                      streamIdleTimeoutMs: KISSOPEN_STREAM_IDLE_TIMEOUT_MS,
                      inferenceMaxRetries: retries,
                  };
        this.#messages =
            apiKey === undefined || endpoint === undefined
                ? Promise.resolve(null)
                : BedrockBearerTokenCredential.tryLoad({ bearerToken: apiKey, env: {} });
    }

    /** The effort a served model's API accepts, nearest to the one asked for. */
    #effort(
        model: string | undefined,
        effort: SessionRunRequest["effort"],
    ): SessionRunRequest["effort"] {
        const protocol = this.#servedRoute(model)?.protocol;
        if (protocol === "responses" && effort === "max") return "xhigh";
        if (protocol === "messages" && effort === "xhigh") return "high";
        return effort;
    }

    #route(model: string | undefined): KissopenRoute {
        if (isDeepSeekModel(model)) return "deepseek";
        const served = this.#servedRoute(model)?.protocol;
        if (served === "chat" || served === "messages") return served;
        return "ordinary";
    }

    async #messagesSession(
        id: string,
        conversation: string,
        options: SessionOptions,
    ): Promise<AnthropicBedrockSession | undefined> {
        const credential = await this.#messages;
        if (credential === null || this.#endpoint === undefined) return undefined;
        return new AnthropicBedrockSession(id, {
            ...options,
            headers: conversationHeaders(conversation),
            credential,
            endpoint: anthropicBase(this.#endpoint),
            // Only the Anthropic client's address and bearer-key mode are used; no AWS region
            // is ever reached.
            region: "us-east-1",
            transport: "mantle",
            inferenceMaxRetries: options.inferenceMaxRetries ?? this.#retries,
        });
    }
    override get name() {
        return this.provider.name;
    }
    override get inputTypes() {
        return this.provider.inputTypes;
    }
    override get outputTypes() {
        return this.provider.outputTypes;
    }
    /**
     * Pictures go through the same account and the same service as the
     * conversation: the KISSOPEN server answers the images API at its own
     * base URL, with the image model it is configured with.
     */
    generateImage(request: GenerateCodexImageRequest): Promise<GenerateCodexImageResult> {
        return this.provider.generateImage(request);
    }
    override async session(id: string, options: SessionOptions): Promise<BaseSession> {
        const ordinary = await this.provider.session(id, options);
        const deepseek = await (await this.#deepseek)?.session(`${id}:deepseek`, options);
        const chat =
            this.#chat === undefined
                ? undefined
                : await new ChatCompletionsProvider({
                      ...this.#chat,
                      headers: conversationHeaders(id),
                  }).session(`${id}:chat`, options);
        const messages = await this.#messagesSession(`${id}:messages`, id, options);
        return new KissopenSession(
            ordinary,
            async (instructions, route) => {
                const summary = {
                    instructions,
                    tools: [],
                    inferenceMaxRetries: 0,
                };
                const checkpointId = `${id}:checkpoint:${randomUUID()}`;
                if (route === "messages") {
                    const session = await this.#messagesSession(checkpointId, id, summary);
                    if (session !== undefined) return session;
                }
                return await this.provider.session(checkpointId, summary);
            },
            {
                ...(deepseek === undefined ? {} : { deepseek }),
                ...(chat === undefined ? {} : { chat }),
                ...(messages === undefined ? {} : { messages }),
            },
            (model) => this.#route(model),
            (model, effort) => this.#effort(model, effort),
        );
    }
}

export class KissopenSession extends BaseSession {
    private lastRequest: SessionRunRequest | undefined;
    constructor(
        private readonly ordinary: BaseSession,
        private readonly createSummary: (
            instructions: string,
            route: KissopenRoute,
        ) => Promise<BaseSession>,
        /** The sessions for the other APIs, where the server can be reached with a device key. */
        private readonly others: Partial<
            Record<Exclude<KissopenRoute, "ordinary">, BaseSession>
        > = {},
        private readonly routeOf: (model: string | undefined) => KissopenRoute = (model) =>
            isDeepSeekModel(model) ? "deepseek" : "ordinary",
        private readonly effortFor: (
            model: string | undefined,
            effort: SessionRunRequest["effort"],
        ) => SessionRunRequest["effort"] = (_model, effort) => effort,
    ) {
        super(ordinary.id);
    }
    #sessionFor(route: KissopenRoute): BaseSession {
        return route === "ordinary" ? this.ordinary : (this.others[route] ?? this.ordinary);
    }
    run(ctx: Context, asked: SessionRunRequest): SessionStream {
        const effort = this.effortFor(asked.model, asked.effort);
        const request =
            effort === asked.effort
                ? asked
                : effort === undefined
                  ? (({ effort: _dropped, ...rest }) => rest)(asked)
                  : { ...asked, effort };
        this.lastRequest = request;
        const ordinary = this.#sessionFor(this.routeOf(request.model));
        return (async function* () {
            const context = await lightenKissopenImages(portableContext(request.context));
            yield* ordinary.run(
                ctx,
                context === request.context ? request : { ...request, context },
            );
        })();
    }
    async destroy(): Promise<void> {
        await Promise.all([
            this.ordinary.destroy(),
            ...Object.values(this.others).map((session) => session.destroy()),
        ]);
    }
    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        if (ctx.lifetime?.aborted) return { status: "cancelled", context: options.context };
        const model = options.model ?? this.lastRequest?.model;
        const route = this.routeOf(model);
        // A Chat Completions session writes its own plaintext checkpoint, through its own API.
        const chat = route === "deepseek" || route === "chat" ? this.others[route] : undefined;
        if (chat !== undefined) {
            return await chat.compact(ctx, {
                ...options,
                context: await lightenKissopenImages(portableContext(options.context)),
            });
        }
        if (!model)
            return {
                status: "failed",
                kind: "inference_error",
                message: "请选择工作模型后再压缩上下文。",
            };
        const instructions = `${options.context.instructions}\n\n${checkpoint}`;
        let summarySession: BaseSession | undefined;
        let summary = "";
        let usage: SessionUsage = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
        };
        let complete = false;
        try {
            summarySession = await this.createSummary(instructions, route);
            const effort =
                this.lastRequest?.effort ??
                (model === "openai/gpt-4o-mini-2024-07-18" ? "off" : undefined);
            const summaryContext = await lightenKissopenImages(
                portableContext({
                    instructions,
                    messages: [
                        ...options.context.messages,
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: `${checkpoint}\n${options.instructions ?? ""}`,
                                },
                            ],
                        },
                    ],
                }),
            );
            for await (const event of summarySession.run(ctx, {
                model,
                ...(effort === undefined ? {} : { effort }),
                context: summaryContext,
            })) {
                if (ctx.lifetime?.aborted) return { status: "cancelled", context: options.context };
                if (event.type === "block_reset") summary = "";
                if (event.type === "text_delta") summary += event.delta;
                if (summary.length > 100000)
                    return {
                        status: "failed",
                        kind: "invalid_summary",
                        message: "上下文摘要超出长度限制，原会话仍然保留。",
                    };
                if (event.type === "token_usage") usage = event.usage;
                if (event.type === "toolcall_start")
                    return {
                        status: "failed",
                        kind: "tool_call",
                        message: "上下文摘要不能执行工具，原会话仍然保留。",
                    };
                if (event.type === "done") {
                    if (event.state === "cancelled")
                        return { status: "cancelled", context: options.context };
                    if (event.state !== "normal")
                        return {
                            status: "failed",
                            kind: "inference_error",
                            message: "上下文摘要未完成，原会话仍然保留。",
                        };
                    complete = true;
                }
            }
            if (!complete || !summary.trim())
                return {
                    status: "failed",
                    kind: "invalid_summary",
                    message: "没有收到完整上下文摘要，原会话仍然保留。",
                };
            return {
                status: "completed",
                summary,
                preservedMessages: [],
                usage,
                context: {
                    instructions: options.context.instructions,
                    messages: [{ role: "compaction", content: summary, encryptedContent: null }],
                },
            };
        } catch {
            return ctx.lifetime?.aborted
                ? { status: "cancelled", context: options.context }
                : {
                      status: "failed",
                      kind: "inference_error",
                      message: "上下文摘要请求失败，原会话仍然保留。",
                  };
        } finally {
            await summarySession?.destroy();
        }
    }
}
