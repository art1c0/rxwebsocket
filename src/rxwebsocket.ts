import {
  BehaviorSubject,
  NextObserver,
  Observable,
  Subject,
  Subscription,
  timer,
} from 'rxjs';
import { WebSocketSubject, WebSocketSubjectConfig } from 'rxjs/webSocket';

type MultiplexEntry<In, Out> = {
  subMsg: () => Out;
  unsubMsg: () => Out;
  messageFilter: (msg: In) => boolean;
  subject: Subject<In>;
  subscribed: boolean;
};

export interface RxWebSocketSubjectConfig<In, Out = any>
  extends WebSocketSubjectConfig<In | Out> {
  maxAttempts?: number;
  maxDelay?: number;
  delay?: number;
  debug?: boolean;
  keepAlive?: boolean;
}

export class RxWebSocketSubject<In, Out = any> {
  private readonly config: RxWebSocketSubjectConfig<In, Out>;
  private socket$: WebSocketSubject<In | Out> | null = null;
  private output$ = new Subject<Out>();
  private input$ = new Subject<In>();
  private multiplexStreams = new Map<string, MultiplexEntry<In, Out>>();
  private timerSubscription: Subscription | null = null;
  private socketSubscription: Subscription | null = null;
  private outputSubscription: Subscription | null = null;
  private subscribersCount = 0;
  private keyCounter = 0;
  private attempts = 0;
  private manuallyCompleted = false;
  readonly state$ = new BehaviorSubject<
    'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'
  >('DISCONNECTED');

  constructor(config: string | RxWebSocketSubjectConfig<In, Out>) {
    const defaults = {
      maxAttempts: Infinity,
      delay: 1000,
      maxDelay: 30000,
      keepAlive: false,
      debug: false,
    };

    this.config =
      typeof config === 'string'
        ? { ...defaults, url: config }
        : { ...defaults, ...config };
  }

  public next(msg: Out): void {
    if (this.state$.value === 'CONNECTED') {
      this.log('Sending message:', msg);
      this.socket$?.next(msg);
    } else {
      this.log('Buffering message:', msg);
      this.output$.next(msg);
    }
  }

  public error(err: unknown): void {
    try {
      this.output$.error(err);
    } catch (e) {
      this.log('Error while reporting to output$:', e);
    }

    try {
      this.input$.error(err);
    } catch (e) {
      this.log('Error while reporting to input$:', e);
    }

    try {
      this.socket$?.error(err);
    } catch (e) {
      this.log('Error while reporting to socket$:', e);
    }

    this.socket$ = null;
    this.manuallyCompleted = true;
    this.state$.next('DISCONNECTED');
    this.log('Connection state changed:', 'DISCONNECTED');
  }

  public complete(): void {
    this.manuallyCompleted = true;
    this.output$.complete();
    this.input$.complete();
    this.disconnect(true);
  }

  public subscribe(observer: NextObserver<In>): Subscription {
    if (this.state$.value === 'DISCONNECTED') {
      this.connect();
    }

    this.subscribersCount++;
    const sub = this.input$.subscribe(observer);

    return new Subscription(() => {
      sub.unsubscribe();
      this.subscribersCount--;
      this.disconnect();
    });
  }

  public multiplex(
    subMsg: () => Out,
    unsubMsg: () => Out,
    messageFilter: (msg: In) => boolean,
  ): Observable<In> {
    if (this.state$.value === 'DISCONNECTED') {
      this.connect();
    }

    const subject = new Subject<In>();

    const entry: MultiplexEntry<In, Out> = {
      subMsg,
      unsubMsg,
      messageFilter,
      subject,
      subscribed: false,
    };

    const key = `mux-${this.keyCounter++}`;
    this.multiplexStreams.set(key, entry);

    if (this.state$.value === 'CONNECTED') {
      try {
        const msg = entry.subMsg();
        this.log('Sending multiplex subscribe message:', msg);
        this.socket$?.next(msg);
        entry.subscribed = true;
      } catch (err) {
        subject.error(err);
        this.log('Error getting multiplex subscribe message:', err);
        return subject.asObservable();
      }
    }

    this.subscribersCount++;

    return new Observable<In>((observer) => {
      const sub = subject.subscribe(observer);

      return () => {
        if (entry.subscribed) {
          try {
            const msg = entry.unsubMsg();
            this.log('Sending multiplex unsubscribe message:', msg);
            this.socket$?.next(msg);
          } catch (err) {
            subject.error(err);
            this.log('Error getting multiplex unsubscribe message:', err);
          }
        }

        this.multiplexStreams.delete(key);
        sub.unsubscribe();
        this.subscribersCount--;
        this.disconnect();
      };
    });
  }

  private log(...args: unknown[]) {
    if (this.config.debug) {
      console.debug('[RxWebSocketSubject]', ...args);
    }
  }

  private composeObserver<T extends Event>(
    internalObs: NextObserver<T>,
    externalObs?: NextObserver<T>,
  ): NextObserver<T> {
    return {
      next: (value: T) => {
        internalObs.next?.(value);
        externalObs?.next?.(value);
      },
    };
  }

  private connect(): void {
    if (
      this.state$.value === 'CONNECTED' ||
      this.state$.value === 'CONNECTING'
    ) {
      return;
    }

    this.manuallyCompleted = false;
    this.state$.next('CONNECTING');
    this.log('Connection state changed:', 'CONNECTING');

    this.socketSubscription?.unsubscribe();
    this.outputSubscription?.unsubscribe();
    this.timerSubscription?.unsubscribe();
    this.timerSubscription = null;

    const internalOpenObserver: NextObserver<Event> = {
      next: () => {
        this.log('WebSocket connection opened');
        for (const [key, entry] of this.multiplexStreams) {
          try {
            const msg = entry.subMsg();
            this.log('Sending multiplex subscribe message:', msg);
            this.socket$?.next(msg);
            entry.subscribed = true;
          } catch (err) {
            entry.subject.error(err);
            this.multiplexStreams.delete(key);
            this.log('Error getting multiplex subscribe message:', err);
          }
        }
        this.state$.next('CONNECTED');
        this.log('Connection state changed:', 'CONNECTED');
        this.attempts = 0;
      },
    };

    const internalCloseObserver: NextObserver<CloseEvent> = {
      next: () => {
        this.state$.next('DISCONNECTED');
        this.log('Connection state changed:', 'DISCONNECTED');

        if (!this.manuallyCompleted) {
          this.log('WebSocket closed unexpectedly, reconnecting...');
          this.reconnect();
        } else {
          this.log('WebSocket closed intentionally, no reconnect.');
        }
      },
    };

    this.socket$ = new WebSocketSubject<In | Out>({
      ...this.config,
      openObserver: this.composeObserver(
        internalOpenObserver,
        this.config.openObserver,
      ),
      closeObserver: this.composeObserver(
        internalCloseObserver,
        this.config.closeObserver,
      ),
    });

    this.outputSubscription = this.output$.subscribe({
      next: (msg) => {
        this.log('Sending message:', msg);
        this.socket$?.next(msg);
      },
    });

    this.socketSubscription = this.socket$.subscribe({
      next: ((msg: In) => {
        this.log('Received message:', msg);
        this.input$.next(msg);
        for (const [, entry] of this.multiplexStreams) {
          try {
            if (entry.messageFilter(msg)) {
              entry.subject.next(msg);
            }
          } catch (err) {
            this.log('Error filtering multiplex message:', err);
            entry.subject.error(err);
          }
        }
      }) as (msg: In | Out) => void,
      error: (err) => {
        this.log('WebSocket error:', err);
        this.state$.next('DISCONNECTED');
        this.reconnect();
      },
      complete: () => {
        this.log('WebSocket complete');
        this.state$.next('DISCONNECTED');
        if (!this.manuallyCompleted) this.reconnect();
      },
    });
  }

  private reconnect(): void {
    if (this.subscribersCount === 0 && !this.config.keepAlive) return;

    if (this.attempts >= (this.config.maxAttempts ?? Infinity)) {
      this.input$.error(new Error('Maximum reconnect attempts reached'));
      this.log('Maximum reconnect attempts reached, giving up.');
      return;
    }

    const due = Math.min(
      (this.config.delay ?? 1000) * 2 ** this.attempts,
      this.config.maxDelay ?? 30000,
    );

    this.attempts++;
    this.log(`Reconnecting in ${due} ms (attempt ${this.attempts})`);

    this.timerSubscription?.unsubscribe();
    this.timerSubscription = timer(due).subscribe(() => this.connect());
  }

  private disconnect(force = false): void {
    if (force || (this.subscribersCount === 0 && !this.config.keepAlive)) {
      this.manuallyCompleted = true;

      this.socketSubscription?.unsubscribe();
      this.outputSubscription?.unsubscribe();
      this.timerSubscription?.unsubscribe();

      this.socket$?.complete();
      this.socket$ = null;
    }
  }
}

export function rxWebSocket<In, Out = any>(
  urlConfigOrSource: string | RxWebSocketSubjectConfig<In, Out>,
): RxWebSocketSubject<In, Out> {
  return new RxWebSocketSubject<In, Out>(urlConfigOrSource);
}
