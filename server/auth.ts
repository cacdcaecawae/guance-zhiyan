import type { IncomingMessage } from 'node:http'

/** Trusted integration boundary. Never accept a browser-supplied user id as identity. */
export interface Identity {
  subject: string
  name: string
}
export type Authenticate = (request: IncomingMessage) => Promise<Identity | undefined>

// School authentication and account provisioning are explicitly deferred.
// Production fails closed until its trusted authenticator is integrated here.
export const authenticate: Authenticate = async () => undefined

/** Explicit single-user local entry; never a public authentication provider. */
export function localAuthenticate(origin: string): Authenticate {
  const url = new URL(origin)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin)
    throw new Error('本机模式只允许 http://127.0.0.1 的同源入口。')
  return async (request) => {
    const peer = request.socket.remoteAddress
    const site = request.headers['sec-fetch-site']
    if (
      (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') ||
      request.headers.host !== url.host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none') ||
      Object.keys(request.headers).some(
        (name) => name === 'forwarded' || name.startsWith('x-forwarded-'),
      )
    )
      return undefined
    return { subject: 'local:owner', name: '本机研究者' }
  }
}
