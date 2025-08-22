# RxJS WebSocket Advanced Wrapper

It is intended to be a drop-in replacement for the standard RxJS [WebSocketSubject](https://rxjs.dev/api/webSocket/WebSocketSubject), but with some additional capabilities:

1. Separate types for input and output data. In fact it is very rare if not impossible that the same data type is being used for input and output for a WebSocket as it is provided by standard RxJS solution, so this problem is resolved by this module.
2. Reconnection with exponential back-off, which is completely absent in standard solution.
3. Buffering outgoing messages during reconnect with auto-sending when connection is re-established. This includes 'subscribe' messages for multiplex.
4. Ability to keep the connection alive when the last multiplex consumer is off. Standard behavior is to disconnect, which is not desirable in some cases.
5. Special subject state$ to track the connection state with values DISCONNECTED, CONNECTING, CONNECTED.
6. Easy logging of all actions and messages with `debug` configuration boolean parameter.

## Install
`npm i rxwebsocket`

The module has only one dependency which is `rxjs` itself.

## Usage

### Configuration object:
```
import { RxWebSocketSubjectConfig } from 'rxwebsocket';
const config: RxWebSocketSubjectConfig = {
    url: 'wss://example.com/websocket',
    debug: true,
};
```

### Instance via function:
```
import { rxWebSocket } from 'rxwebsocket';
const socket$ = rxWebSocket<Input, Output>(config);
```

### Instance via class:
```
import { RxWebSocketSubject } from 'rxwebsocket';
const socket$ = new RxWebSocketSubject<Input, Output>(config);
```

### Tracking connection state
```
socket$.state$.subscribe({
  next: (state) => {
    console.log('Connection state:', state);
  },
});
```

### Sending data
Syntax is the same as with standard RxJS WebSocketSubject.

```
socket$.next({ some: 'data' });
```

### Receiving data
Syntax is the same as with standard RxJS WebSocketSubject.

```
socket$.subscribe({
  next: (message) => {
    console.log('Incoming message:', message);
  },
});
```

### Multiplexing
Syntax is the same as with standard RxJS WebSocketSubject.

Please note that in case of reconnect 'subscribe' message will be sent automatically, so you don't have to implement that manually.

If you don't want connection to be closed after the last multiplex consumer unsubscribes, specify `keepAlive: true` in config object.

```
socket$.multiplex(
  () => ({ type: 'subscribe', symbol: 'AAPL' }),
  () => ({ type: 'unsubscribe', symbol: 'AAPL' }),
  (data) => data.type === 'trade',
);
```

## Configuration parameters
`RxWebSocketSubjectConfig` extends standard [WebSocketSubjectConfig](https://rxjs.dev/api/webSocket/WebSocketSubjectConfig) with extra optional parameters:

### maxAttempts: number
> Number of reconnection attempts to make. Defaults to `Infinity`.

### maxDelay: number
> Number of milliseconds that limits exponential delay to reconnect. Defaults to `30000`.

### delay: number
> Number of milliseconds to start exponential delay with. Defaults to `1000`.

### keepAlive: boolean
> Do not disconnect when the last multiplex consumer unsubscribes. Defaults to `false`.

### debug: boolean
> Enable logging of all actions and messages (with `console.debug`). Defaults to `false`.
