import {
  isValidRoomCode,
  SHARED_ROOM_PROTOCOL_VERSION,
  SHARED_ROOM_TTL_MS,
} from './sharedRoomProtocol';

export { RoomDurableObject } from './roomDurableObject';

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectStubLike;
}

export interface Env {
  ASSETS: AssetFetcher;
  ROOMS: DurableObjectNamespaceLike;
}

const ROOM_CREATE_PATH = '/api/rooms';
const MAX_CREATE_ATTEMPTS = 8;
const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function jsonError(code: string, message: string, status: number): Response {
  return jsonResponse({ error: code, code, message }, status);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    result += BASE64URL_ALPHABET[(value >>> 18) & 63];
    result += BASE64URL_ALPHABET[(value >>> 12) & 63];
    if (second !== undefined) result += BASE64URL_ALPHABET[(value >>> 6) & 63];
    if (third !== undefined) result += BASE64URL_ALPHABET[value & 63];
  }
  return result;
}

function generateRoomCode(): string {
  const bytes = randomBytes(10);
  let roomCode = '';
  for (const byte of bytes) roomCode += ROOM_CODE_ALPHABET[byte & 31];
  return roomCode;
}

function generateHostToken(): string {
  return encodeBase64Url(randomBytes(32));
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
    let roomCode: string;
    let hostToken: string;
    try {
      roomCode = generateRoomCode();
      hostToken = generateHostToken();
    } catch {
      return jsonError('entropy_unavailable', 'Secure room credentials could not be generated', 503);
    }

    const expiresAt = Date.now() + SHARED_ROOM_TTL_MS;
    let response: Response;
    try {
      const stub = env.ROOMS.idFromName(roomCode);
      const internalUrl = new URL('/internal/create', request.url);
      const internalRequest = new Request(internalUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostToken, roomCode, expiresAt }),
      });
      response = await stub.fetch(internalRequest);
    } catch {
      return jsonError('room_unavailable', 'The room service is temporarily unavailable', 503);
    }

    if (response.status === 409) continue;
    if (!response.ok) return jsonError('room_unavailable', 'The room could not be created', 503);

    return jsonResponse({
      protocolVersion: SHARED_ROOM_PROTOCOL_VERSION,
      roomCode,
      hostToken,
      expiresAt,
    });
  }

  return jsonError('room_unavailable', 'A unique room could not be allocated', 503);
}

async function forwardWebSocket(request: Request, env: Env, roomCode: string): Promise<Response> {
  if (!isValidRoomCode(roomCode)) return jsonError('invalid_room_code', 'Room code is invalid', 400);
  if (request.method !== 'GET') return jsonError('method_not_allowed', 'WebSocket rooms require GET', 405);
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return jsonError('upgrade_required', 'A WebSocket upgrade is required', 426);
  }

  try {
    const stub = env.ROOMS.idFromName(roomCode);
    const internalUrl = new URL('/ws', request.url);
    return await stub.fetch(new Request(internalUrl, request));
  } catch {
    return jsonError('room_unavailable', 'The room service is temporarily unavailable', 503);
  }
}

export async function fetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === ROOM_CREATE_PATH) {
    if (request.method !== 'POST') return jsonError('method_not_allowed', 'Room creation requires POST', 405);
    return await createRoom(request, env);
  }

  const websocketMatch = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
  if (websocketMatch) return forwardWebSocket(request, env, websocketMatch[1]);

  if (url.pathname.startsWith('/api/')) {
    return jsonError('not_found', 'API route not found', 404);
  }

  return env.ASSETS.fetch(request);
}

export default { fetch };
