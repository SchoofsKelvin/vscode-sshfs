
export type toPromiseCallback<T> = (err?: Error | null, res?: T) => void;
export async function toPromise<T>(func: (cb: toPromiseCallback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      func((err, res) => err ? reject(err) : resolve(res!));
    } catch (e) {
      reject(e);
    }
  });
}

export async function catchingPromise<T>(executor: (resolve: (value?: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => any): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      const p = executor(resolve, reject);
      if (p instanceof Promise) {
        p.catch(reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

export async function reduceAsync<R, T>(array: T[], reducer: (prev: R, current: T, index: number, array: T[]) => R | PromiseLike<R>, initial: R | PromiseLike<R>): Promise<R> {
  return array.reduce<Promise<R>>((prev, curr, index) => prev.then(p => reducer(p, curr, index, array)), Promise.resolve(initial));
}

export async function reduceRightAsync<R, T>(array: T[], reducer: (prev: R, current: T, index: number, array: T[]) => R | PromiseLike<R>, initial: R | PromiseLike<R>): Promise<R> {
  return array.reduceRight<Promise<R>>((prev, curr, index) => prev.then(p => reducer(p, curr, index, array)), Promise.resolve(initial));
}
