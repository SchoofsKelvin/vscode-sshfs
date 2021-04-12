
import 'ssh2';
declare module 'ssh2' {
    export interface UnixConnectionDetails {
        socketPath: string;
    }
    export interface Client {
        // Missing from @types/ssh2 (but with it being so behind and ssh2 being rewritten, useless to add a PR to fix this)
        /** Emitted when an incoming forwarded unix connection is being requested. */
        on(event: "unix connection", listener: (details: UnixConnectionDetails, accept: () => ClientChannel, reject: () => void) => void): this;
    }
}
