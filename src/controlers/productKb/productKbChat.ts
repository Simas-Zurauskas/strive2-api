import { EventEmitter } from 'events';
import asyncHandler from 'express-async-handler';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { CHAT_ROLES } from '@lib/constants';
import { productKbAgent } from '@src/lib/ai/agents/productKb';
import { runMentorAgentStream } from '@src/lib/ai/agents/shared/runMentorAgentStream';
import { sanitizePromptInput } from '@lib/sanitize';
import { chatLog } from '@lib/loggers';

/**
 * Request validation. Mirrors `chatStreamSchema` but without
 * `attachmentIds` — the product-KB chat is ephemeral and has no
 * attachment surface in v1. The message + content caps are anti-abuse
 * defence-in-depth on top of the per-IP/user rate limiter (8/min burst,
 * 30/hr sustained, see productKbRoutes.ts).
 *
 * 4 000 chars per message comfortably fits any legitimate help-bot
 * question (a paragraph is ~500 chars; a multi-part question with a
 * pasted error message rarely exceeds 2 000). 12 messages = 6 turns of
 * Q&A — generous for a help-bot interaction. Worst-case per-call input
 * size drops from 20 × 20 000 = 400 000 chars to 12 × 4 000 = 48 000
 * chars (~12 K tokens), an ~8× reduction in per-call LLM spend ceiling.
 */
const productKbChatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(CHAT_ROLES),
        content: z.string().min(1).max(4000),
      }),
    )
    .min(1)
    .max(12),
});

/**
 * @swagger
 * /api/product-kb/chat:
 *   post:
 *     summary: Stream a chat message for the product knowledge-base guide
 *     tags:
 *       - ProductKb
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messages]
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   $ref: '#/components/schemas/ChatMessage'
 *     responses:
 *       200:
 *         description: SSE stream of chat response
 */
export const productKbChatController = asyncHandler(async (req, res) => {
  // Optional: present iff `optionalProtect` decoded a valid token. The
  // chat itself runs identically for anonymous visitors — only the
  // telemetry attribution differs (logged below; tagged on usage events
  // through the active AsyncLocalStorage scope when available).
  const userId = req.userId;

  // AI SDK v3 sends messages with `parts` instead of `content` — normalise
  // to match the rest of the api's chat surfaces.
  if (Array.isArray(req.body?.messages)) {
    for (const msg of req.body.messages) {
      if (!msg.content && Array.isArray(msg.parts)) {
        msg.content = msg.parts
          .filter((p: { type: string }) => p.type === 'text')
          .map((p: { text: string }) => p.text)
          .join('');
      }
    }
  }

  const parseResult = productKbChatSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ message: parseResult.error.issues[0]?.message ?? 'Invalid input' });
    return;
  }

  const { messages: rawMessages } = parseResult.data;

  // Sanitize the latest user message (first-turn input is the only
  // place an injection vector enters; the rest of the history is
  // server-controlled text from prior assistant turns).
  const lastMessage = rawMessages[rawMessages.length - 1];
  if (lastMessage?.role === 'user') {
    lastMessage.content = sanitizePromptInput(lastMessage.content);
  }

  const messages = rawMessages.map((m) =>
    m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content),
  );

  // ── SSE headers ────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Content-Encoding', 'none');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('x-vercel-ai-ui-message-stream', 'v1');
  res.flushHeaders();

  const abortController = new AbortController();
  const tokenEmitter = new EventEmitter();
  let clientConnected = true;
  const turnStartedAt = Date.now();

  chatLog.info(
    `pkb:turn start user=${userId ?? 'anon'} ip=${req.ip ?? '?'} historyMessages=${messages.length}`,
  );

  res.on('close', () => {
    if (!clientConnected) return;
    clientConnected = false;
    abortController.abort();
    tokenEmitter.removeAllListeners();
    chatLog.warn(`pkb:stream client disconnect ms=${Date.now() - turnStartedAt}`);
  });

  const { ok } = await runMentorAgentStream({
    res,
    abortController,
    isClientConnected: () => clientConnected,
    agent: productKbAgent,
    agentInput: { messages },
    agentConfigurable: {
      ...(userId ? { userId } : {}),
      tokenEmitter,
      abortSignal: abortController.signal,
    },
    scope: 'productKb',
  });

  if (!ok) {
    chatLog.warn(`pkb:turn done ok=false ms=${Date.now() - turnStartedAt}`);
    return;
  }
  chatLog.info(`pkb:turn done ok=true ms=${Date.now() - turnStartedAt}`);

  // No credit debit. The product-KB chat is free for everyone (anonymous
  // visitors included) — abuse is bounded by the per-IP / per-user rate
  // limiters mounted on the route, not by per-message billing. Vendor
  // cost is still recorded via `recordUsage` from the agent's tools, so
  // aggregate spend remains visible in the usage dashboard even when no
  // user is attributed.
});
