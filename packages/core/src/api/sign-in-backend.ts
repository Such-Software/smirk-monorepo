/**
 * A sign-in belongs to the backend it started on.
 *
 * A session token is valid only at the backend that minted it, and the client
 * presents it on every authenticated call to wherever it points at the time.
 * Every sign-in path awaits the network several times, and the shared client
 * can be re-pointed in between: Settings switches the backend, another window
 * resets it, or this context follows another context's change. A token
 * installed after such a move goes to the new operator as a bearer for the old
 * one, on every call, until it expires. (Reproduced 2026-10-11 against two
 * local stub backends: a sign-in still running when the window switched
 * installed the old backend's token on the newly pointed client.)
 *
 * So a sign-in pins the backend it started on. It checks the pin after each
 * await, before its next request, and installs its token only while the client
 * still points there. A sign-in that loses its backend stops; the context
 * signs in again at the new one.
 */

/** The part of the api client a pin reads and writes. */
export interface PinnableClient {
  getBaseUrl(): string;
  setAccessToken(token: string | null): void;
}

/** Thrown when the client moved to another backend during a sign-in. */
export class BackendChangedError extends Error {
  /** The backend the sign-in started on. */
  readonly from: string;
  /** Where the client points now. */
  readonly to: string;

  constructor(from: string, to: string) {
    super(
      `The sign-in to ${from} was stopped because Smirk now uses ${to}. ` +
        `Nothing from it was kept; Smirk signs in again at ${to}.`,
    );
    this.name = 'BackendChangedError';
    this.from = from;
    this.to = to;
  }
}

/** True for the error a pinned sign-in throws when its backend moved. */
export function isBackendChangedError(e: unknown): e is BackendChangedError {
  return e instanceof BackendChangedError;
}

export interface PinnedBackend {
  /** The backend the sign-in started on. */
  readonly url: string;
  /** Throws {@link BackendChangedError} once the client points anywhere else. */
  assertCurrent(): void;
  /**
   * Install `token`, minted by {@link url}, as the session token. Refuses,
   * installing nothing, when the client no longer points at {@link url}.
   */
  installToken(token: string): void;
}

/**
 * Pin a sign-in to the backend `client` points at now. Call it before the
 * sign-in's first await.
 */
export function pinBackend(client: PinnableClient): PinnedBackend {
  const url = client.getBaseUrl();
  const assertCurrent = (): void => {
    const now = client.getBaseUrl();
    if (now !== url) throw new BackendChangedError(url, now);
  };
  return {
    url,
    assertCurrent,
    installToken(token: string): void {
      assertCurrent();
      client.setAccessToken(token);
    },
  };
}
