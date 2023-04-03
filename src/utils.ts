import type { EnvironmentVariable } from 'common/fileSystemConfig';
import { DEBUG } from './logging';

function prepareStackTraceDefault(error: Error, stackTraces: NodeJS.CallSite[]): string {
    return stackTraces.reduce((s, c) => `${s}\n\tat ${c} (${c.getFunction()})`, `${error.name || "Error"}: ${error.message || ""}`);
}
function trimError(error: Error, depth: number): [string[], Error] {
    const pst = Error.prepareStackTrace;
    let trimmed = '';
    Error.prepareStackTrace = (err, stack) => {
        const result = (pst || prepareStackTraceDefault)(err, stack.slice(depth + 1));
        trimmed = (pst || prepareStackTraceDefault)(err, stack.slice(0, depth + 1));
        return result;
    };
    Error.captureStackTrace(error);
    error.stack = error.stack;
    Error.prepareStackTrace = pst;
    return [trimmed.split('\n').slice(1), error];
}
/** Wrapper around async callback-based functions */
export async function catchingPromise<T>(executor: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => any, trimStack = 0, causeName = 'catchingPromise'): Promise<T> {
    let [trimmed, promiseCause]: [string[], Error] = [] as any;
    return new Promise<T>((resolve, reject) => {
        [trimmed, promiseCause] = trimError(new Error(), trimStack + 2);
        if (DEBUG) promiseCause.stack = promiseCause.stack!.split('\n', 2)[0] + trimmed.map(l => l.replace('at', '~at')).join('\n') + '\n' + promiseCause.stack!.split('\n').slice(1).join('\n');
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
            let stack = e.stack;
            if (stack) {
                const lines = stack.split('\n');
                let index = lines.indexOf(trimmed[3]);
                if (index !== -1) {
                    index -= 2 + trimStack;
                    e.stack = lines[0] + '\n' + lines.slice(1, index).join('\n');
                    if (DEBUG) e.stack += '\n' + lines.slice(index).map(l => l.replace('at', '~at')).join('\n');
                }
            }
            let t = (e as any).promiseCause;
            if (!(t instanceof Error)) t = e;
            if (!('promiseCause' in t)) {
                Object.defineProperty(t, 'promiseCause', {
                    value: promiseCause,
                    configurable: true,
                    enumerable: false,
                });
                Object.defineProperty(t, 'promiseCauseName', {
                    value: causeName,
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
    }, 2, 'toPromise');
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
export function escapeBashValue(value: string) {
    if (CLEAN_BASH_VALUE_REGEX.test(value)) return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Convert an {@link EnvironmentVariable} array to a `export var1=val; export var2='escaped$val'` etc */
export function environmentToExportString(env: EnvironmentVariable[], createSetEnv: (key: string, value: string) => string): string {
    return env.map(({ key, value }) => createSetEnv(escapeBashValue(key), escapeBashValue(value))).join('; ');
}

/** Returns a new {@link EnvironmentVariable} array with all the given environments merged into it, overwriting same-key variables */
export function mergeEnvironment(...environments: (EnvironmentVariable[] | Record<string, string> | undefined)[]): EnvironmentVariable[] {
    const result = new Map<string, EnvironmentVariable>();
    for (let other of environments) {
        if (!other) continue;
        if (Array.isArray(other)) {
            for (const variable of other) result.set(variable.key, variable);
        } else {
            for (const [key, value] of Object.entries(other)) {
                result.set(key, { key, value });
            }
        }
    }
    return [...result.values()];
}

/** Joins the commands together using the given separator. Automatically ignores `undefined` and empty strings */
export function joinCommands(commands: string | string[] | undefined, separator: string): string | undefined {
    if (typeof commands === 'string') return commands;
    return commands?.filter(c => c?.trim()).join(separator);
}
