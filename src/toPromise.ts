
export type toPromiseCallback<T> = (err: Error | null, res?: T) => void;
export async function toPromise<T>(func: (cb: toPromiseCallback<T>) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    func((err, res) => err ? reject(err) : resolve(res));
  });
}
