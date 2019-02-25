
import { Duplex, Writable } from 'stream';

export class MemoryDuplex extends Duplex {
  protected buffer = Buffer.alloc(this.size);
  protected buffered = 0;
  protected doPush = false;
  constructor(public readonly size: number = 4092) {
    super();
  }
  // tslint:disable-next-line:function-name
  public _write(chunk: any, encoding: string, callback: (err?: Error) => void) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk, encoding);
    const end = this.buffered + buffer.length;
    if (end > this.size) {
      return callback(new Error('Buffer overflow'));
    }
    this.buffered += buffer.copy(this.buffer, this.buffered, 0);
    if (this.doPush) this._read();
    callback();
  }
  // tslint:disable-next-line:function-name
  public _read() {
    const slice = this.buffer.slice(0, this.buffered);
    this.buffered = 0;
    this.buffer = Buffer.alloc(this.size);
    this.doPush = this.push(slice);
  }
  public bytesBuffered() {
    return this.buffered;
  }
}

export class WritableFunctionStream extends Writable {
  constructor(protected func: (data: Buffer) => void) {
    super();
  }
  // tslint:disable-next-line:function-name
  public async _write(chunk: any, encoding: string, callback: (err?: Error) => void) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk, encoding);
    try {
      await this.func(buffer);
      callback();
    } catch (e) {
      callback(e);
    }
  }
}
