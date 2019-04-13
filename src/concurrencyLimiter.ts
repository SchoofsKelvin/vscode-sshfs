
type Task = () => any;
export class ConcurrencyLimiter {
  protected tasks: Task[] = [];
  protected workers: Promise<void>[] = [];
  constructor(protected maxWorkers = 10) { }
  public addTask(task: Task) {
    this.tasks.push(task);
    if (this.workers.length < this.maxWorkers) {
      this.createWorker();
    }
  }
  public clear() {
    this.tasks = [];
  }
  public toPromise() {
    if (!this.workers.length) return Promise.resolve();
    return Promise.all(this.workers).then(() => this.toPromise());
  }
  protected async createWorker() {
    const worker = this.taskRunner();
    this.workers.push(worker);
    worker.catch(() => { }).then(() => this.workers.splice(this.workers.indexOf(worker)));
  }
  protected async taskRunner() {
    let task: Task | undefined = this.tasks.pop();
    while (task) {
      try {
        await task();
      } catch (e) { }
      task = this.tasks.pop();
    }
  }
}
