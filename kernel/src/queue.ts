// 轻量异步队列：生产者随时 push，消费者 for-await 逐条拉取。
// 用于并行任务（只读工具滚动池、并行子代理）把事件实时汇入主循环。
export class AsyncQueue<T> {
  private buf: T[] = [];
  private waiter: (() => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    this.buf.push(item);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  close(): void {
    this.done = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      while (this.buf.length) yield this.buf.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => { this.waiter = r; });
    }
  }
}
