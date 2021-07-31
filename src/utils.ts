import type { EnvironmentVariable } from "./fileSystemConfig";

/** Wrapper around async callback-based functions */
export async function catchingPromise<T>(executor: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => any): Promise<T> {
    const promiseCause = new Error();
    Error.captureStackTrace(promiseCause, catchingPromise);
    return new Promise<T>((resolve, reject) => {
        try {
            const p = executor(resolve, reject);
            if (p instanceof Promise) {
                p.catch(reject);
            }
        } catch (e) {
            reject(e);
        }
    }).catch(e => {
        if (e instanceof Error) {
            let t = (e as any).promiseCause;
            if (!(t instanceof Error)) t = e;
            if (!('promiseCause' in t)) {
                Object.defineProperty(e, 'promiseCause', {
                    value: promiseCause.stack,
                    configurable: true,
                    enumerable: false,
                });
            }
        }
        throw e;
    });
}

export type toPromiseCallback<T> = (err?: Error | null | void, res?: T) => void;
/** Wrapper around async callback-based functions */
export async function toPromise<T>(func: (cb: toPromiseCallback<T>) => void): Promise<T> {
    return catchingPromise((resolve, reject) => {
        func((err, res) => err ? reject(err) : resolve(res!));
    });
}

/** Converts the given number/string to a port number. Throws an error for invalid strings or ports outside the 1-65565 range */
export function validatePort(port: string | number): number {
    const p = Number(port);
    if (!Number.isInteger(p)) throw new Error(`Wanting to use non-int '${port}' as port`);
    if (p < 0 || p > 65565) throw new Error(`Wanting to use port ${p} outside the 1-65565 range`);
    return p;
}

const CLEAN_BASH_VALUE_REGEX = /^[\w-/\\]+$/;
/** Based on way 1 in https://stackoverflow.com/a/20053121 */
function escapeBashValue(value: string) {
    if (CLEAN_BASH_VALUE_REGEX.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Convert an {@link EnvironmentVariable} array to a `export var1=val; export var2='escaped$val'` etc */
export function environmentToExportString(env: EnvironmentVariable[]): string {
    return env.map(({ key, value }) => `export ${escapeBashValue(key)}=${escapeBashValue(value)}`).join('; ');
}

/** Returns a new {@link EnvironmentVariable} array with all the given environments merged into it, overwriting same-key variables */
export function mergeEnvironment(env: EnvironmentVariable[], ...others: (EnvironmentVariable[] | Record<string, string> | undefined)[]): EnvironmentVariable[] {
    const result = [...env];
    for (const other of others) {
        if (!other) continue;
        if (Array.isArray(other)) {
            for (const variable of other) {
                const index = result.findIndex(v => v.key === variable.key);
                if (index === -1) result.push(variable);
                else result[index] = variable;
            }
        } else {
            for (const [key, value] of Object.entries(other)) {
                result.push({ key, value });
            }
        }
    }
    return result;
}

/** Joins the commands together using the given separator. Automatically ignores `undefined` and empty strings */
export function joinCommands(commands: string | string[] | undefined, separator: string): string | undefined {
    if (!commands) return undefined;
    if (typeof commands === 'string') return commands;
    return commands.filter(c => c && c.trim()).join(separator);
}
