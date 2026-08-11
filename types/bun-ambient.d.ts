/**
 * Minimal ambient declarations for the Bun APIs used in this repository.
 *
 * These are hand-written on purpose: the project forbids third-party
 * dependencies (`@types/bun` included), so only the surface actually consumed
 * by `@qianmo/*` packages is declared here. Extend it as new Bun APIs are used.
 */

declare module "bun:test" {
  export interface Matchers {
    readonly not: Matchers;
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toContain(expected: unknown): void;
    toContainEqual(expected: unknown): void;
    toHaveLength(expected: number): void;
    toHaveProperty(key: string, value?: unknown): void;
    toBeInstanceOf(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toThrow(expected?: unknown): void;
  }

  export type TestBody = () => void | Promise<void>;

  export function describe(label: string, body: () => void): void;
  export function test(label: string, body: TestBody): void;
  export function it(label: string, body: TestBody): void;
  export function beforeAll(body: TestBody): void;
  export function beforeEach(body: TestBody): void;
  export function afterAll(body: TestBody): void;
  export function afterEach(body: TestBody): void;
  export function expect(actual: unknown): Matchers;
}

declare namespace Bun {
  interface ServeOptions {
    /** `0` asks the OS for a free port; read the real one back from `Server.port`. */
    port?: number;
    hostname?: string;
    fetch: (request: Request, server: Server) => Response | Promise<Response>;
    error?: (error: Error) => Response | Promise<Response>;
  }

  interface Server {
    readonly port: number;
    readonly hostname: string;
    readonly url: URL;
    stop(closeActiveConnections?: boolean): Promise<void>;
  }

  function serve(options: ServeOptions): Server;
}
