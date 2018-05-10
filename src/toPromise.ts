
export type toPromiseCallback<T> = (err: Error | null, res?: T) => void;
export async function toPromise<T>(func: (cb: toPromiseCallback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    func((err, res) => err ? reject(err) : resolve(res));
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
