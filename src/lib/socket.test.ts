/**
 * Tests for the Socket.io handshake middleware. Mirrors HTTP `protect +
 * requireVerified` — bugs here mean wrong users get other users' job-complete
 * events or unverified credentials users open sockets they shouldn't.
 *
 * Run: yarn test socket
 */

import assert from 'node:assert/strict';
import { describe, test, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { setupTestDb } from '../../test-helpers/db';
import { makeUser, UserModel } from '../../test-helpers/factories';
import { socketAuthMiddleware } from '@lib/socket';
import { generateAuthToken } from '@lib/auth';
import { JWT_SECRET } from '@conf/env';
import { AuthProvider } from '@lib/constants';

setupTestDb();

interface SocketStub {
  handshake: { auth: { token?: string } };
  data: { userId?: string };
}

const fakeSocket = (token?: string): SocketStub => ({
  handshake: { auth: { token } },
  data: {},
});

const runHandshake = (socket: SocketStub): Promise<{ accepted: boolean; error?: Error }> => {
  return new Promise((resolve) => {
    socketAuthMiddleware(socket, (err?: Error) => {
      resolve({ accepted: !err, error: err });
    }).catch((err) => resolve({ accepted: false, error: err as Error }));
  });
};

// ── Happy path ─────────────────────────────────────────

describe('socketAuthMiddleware happy path', () => {
  test('valid token + matching tokenVersion + verified user → accepted, userId stamped', async () => {
    const user = await makeUser({ emailVerified: true });
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    const socket = fakeSocket(token);

    const result = await runHandshake(socket);
    expect(result.accepted).toBe(true);
    expect(socket.data.userId).toBe(user._id.toString());
  });

  test('Google-only user (no CREDENTIALS) bypasses email-verified check', async () => {
    const user = await makeUser({
      emailVerified: false, // unverified, but ...
      authProviders: [{ provider: AuthProvider.GOOGLE, providerId: 'g-1' }], // no CREDENTIALS
    });
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    const socket = fakeSocket(token);

    const result = await runHandshake(socket);
    expect(result.accepted).toBe(true);
    expect(socket.data.userId).toBe(user._id.toString());
  });
});

// ── Rejection paths ────────────────────────────────────

describe('socketAuthMiddleware rejection paths', () => {
  test('missing token → Error("Unauthorized")', async () => {
    const socket = fakeSocket(undefined);
    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('Unauthorized');
  });

  test('garbage token → Unauthorized', async () => {
    const socket = fakeSocket('not-a-jwt');
    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('Unauthorized');
  });

  test('expired token → Unauthorized', async () => {
    const user = await makeUser();
    const expired = jwt.sign(
      { id: user._id.toString(), tokenVersion: user.tokenVersion },
      JWT_SECRET,
      { algorithm: 'HS256', expiresIn: -10 },
    );
    const socket = fakeSocket(expired);
    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('Unauthorized');
  });

  test('tokenVersion mismatch (user logged out elsewhere) → Unauthorized', async () => {
    const user = await makeUser();
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: 0 });
    await UserModel.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });

    const socket = fakeSocket(token);
    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('Unauthorized');
  });

  test('user deleted → Unauthorized', async () => {
    const user = await makeUser();
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    await UserModel.deleteOne({ _id: user._id });

    const socket = fakeSocket(token);
    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('Unauthorized');
  });

  test('CREDENTIALS user, unverified → EMAIL_NOT_VERIFIED (distinct from Unauthorized)', async () => {
    const user = await makeUser({ emailVerified: false }); // default authProviders is CREDENTIALS
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    const socket = fakeSocket(token);

    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('EMAIL_NOT_VERIFIED');
    // Not stamped — must NOT join the user room
    expect(socket.data.userId).toBeUndefined();
  });

  test('mixed providers (CREDENTIALS unverified + GOOGLE) → EMAIL_NOT_VERIFIED still fires', async () => {
    const user = await makeUser({
      emailVerified: false,
      authProviders: [
        { provider: AuthProvider.CREDENTIALS },
        { provider: AuthProvider.GOOGLE, providerId: 'g-2' },
      ],
    });
    const token = generateAuthToken({ id: user._id.toString(), tokenVersion: user.tokenVersion });
    const socket = fakeSocket(token);

    const result = await runHandshake(socket);
    expect(result.accepted).toBe(false);
    expect(result.error?.message).toBe('EMAIL_NOT_VERIFIED');
  });
});
