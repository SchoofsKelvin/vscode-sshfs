
declare module 'ssh2' {
    import * as net from 'net';
    import { BaseAgent } from 'ssh2/lib/agent';
    import { ParsedKey, parseKey } from 'ssh2/lib/protocol/keyParser';
    import type * as sftp from 'ssh2/lib/protocol/SFTP';
    import { flagsToString, OPEN_MODE, SFTP, STATUS_CODE, stringToFlags } from 'ssh2/lib/protocol/SFTP';
    import * as stream from 'stream';

    // Export all the agent stuff. The exported members in it are also directly exported in the main module
    export * from 'ssh2/lib/agent';
    // Export type SFTP type so the user doesn't have to import `ssh2/lib/protocol/SFTP` to use it as a type.
    // The class/value itself is not exported here, since code-wise it also isn't present in the main module!
    export type { SFTP };
    // Export all the other SFTP types as a type-only namespace (e.g. Stats, Attributes, ...)
    export { sftp };

    /** Used in {@link HandshakeNegotiation} */
    export interface HandshakeNegotiationAlgorithms {
        /** The ciphre used, e.g. `aes128-gcm */
        cipher: string;
        /** The mac. Can be an empty string, e.g. for AES in GCM mode */
        mac: string;
        compress: string;
        lang: string;
    }

    /** Used for the `handshake` event on {@link Client} */
    export interface HandshakeNegotiation {
        key: string;
        srvHostKey: string;
        /** Client to server algorithms */
        cs: HandshakeNegotiationAlgorithms;
        /** Server to client algorithms */
        sc: HandshakeNegotiationAlgorithms;
    }

    /** Used for the `handshake` event on {@link Client} and in {@link AuthHandlerKeyboardInteractive} */
    export type KeyboardInteractiveListener = (
        name: string,
        instructions: string,
        instructionsLang: string,
        prompts: { prompt: string; echo: boolean }[],
        finish: (answers: string[]) => void
    ) => void;

    /** Used for the `tcp connection` event on {@link Client} */
    export interface TcpConnectionDetails {
        /** The remote IP the connection was received on (given in earlier call to `forwardIn()`). */
        destIP: string;
        /** The remote port the connection was received on (given in earlier call to `forwardIn()`). */
        destPort: number;
        /** The originating IP of the connection. */
        srcIP: string;
        /** The originating port of the connection. */
        srcPort: number;
    }

    /** Used for the `unix connection` event on {@link Client} */
    export interface UnixConnectionDetails {
        /** The original UNIX socket path of the connection */
        socketPath: string;
    }

    /** Used for the `x11` event on {@link Client} */
    export interface X11ConnectionDetails {
        /** The originating IP of the connection. */
        srcIP: string;
        /** The originating port of the connection. */
        srcPort: number;
    }

    /** Used in {@link Algorithms}. Either an exact list or an object on how to modify the default list */
    export type AlgorithmEntry = string[] | {
        append?: (string | RegExp)[];
        prepend?: (string | RegExp)[];
        remove?: (string | RegExp)[];
    };

    /**
     * Used for {@link ConnectConfig.algorithms}.
     * See [the documentation](https://github.com/mscdex/ssh2/tree/master#api) of
     * the version you use to see the default/supported list algorithms.
     */
    export interface Algorithms {
        cipher?: AlgorithmEntry;
        compress?: AlgorithmEntry;
        hmac?: AlgorithmEntry;
        kex?: AlgorithmEntry;
        serverHostKey?: AlgorithmEntry;
    }

    export type AuthHandlerFunction =
        ((methodsLeft: string[], partialSuccess: boolean) => AuthHandlerObject | AuthHandlerObject['type'] | false)
        | ((methodsLeft: string[], partialSuccess: boolean, callback: (method: AuthHandlerObject | AuthHandlerObject['type'] | false) => void) => void);

    export interface AuthHandlerNone {
        type: 'none';
        username: string;
    }
    export interface AuthHandlerPassword {
        type: 'password';
        username: string;
        password: string;
    }
    export interface AuthHandlerPublicKey {
        type: 'publickey';
        username: string;
        /** Should be (parseable to) a ParsedKey containing a private key */
        key: string | Buffer | ParsedKey;
        /** Optional passphrase in case `key` is an encrypted key */
        passphrase?: string;
        /** [PATCH:convertSha1#309] If true, make ssh-rsa keys use sha512/sha256 instead of sha1 if possible */
        convertSha1?: boolean;
    }
    export interface AuthHandlerHostBased {
        type: 'hostbased';
        username: string;
        localHostname: string;
        localUsername: string;
        /** Should be (parseable to) a ParsedKey containing a private key */
        key: string | Buffer | ParsedKey;
        /** Optional passphrase in case `key` is an encrypted key */
        passphrase?: string;
    }
    export interface AuthHandlerAgent {
        type: 'agent';
        username: string;
        agent: string | BaseAgent;
        /** [PATCH:convertSha1#309] If true, make ssh-rsa keys use sha512/sha256 instead of sha1 if possible */
        convertSha1?: boolean;
    }
    export interface AuthHandlerKeyboardInteractive {
        type: 'keyboard-interactive';
        username: string;
        prompt: KeyboardInteractiveListener;
    }

    export type AuthHandlerObject =
        | AuthHandlerNone | AuthHandlerPassword | AuthHandlerPublicKey
        | AuthHandlerHostBased | AuthHandlerAgent | AuthHandlerKeyboardInteractive;

    export type AuthHandler = AuthHandlerFunction | AuthHandlerObject;

    /** Used in {@link Client.connect} */
    export interface ConnectConfig {
        /** Path to `ssh-agent` (Cygwin) UNIX socket or Windows pipe, or `pageant` for Pageant */
        agent?: string;
        /** Set to true to use OpenSSH agent forwarding (`auth-agent@openssh.com`). Needs `agent` for this */
        agentForward?: boolean;
        /** Explicitly override default transport layer algorithms */
        algorithms?: Algorithms;
        /**
         * AuthHandler which determines in which order/way the client tries to authenticate.
         * - Can be an array of {@link AuthHandlerObject} objects to allow for specific authentication methods
         * - Can be an array of {@link AuthHandlerObject} types, where the extra data is read from the config (DEPRECATED)
         * - Can be an {@link AuthHandlerFunction} which allows for more complex logic. See {@link AuthHandlerFunction}
         * 
         * Default value is `['none', 'password', 'publickey', 'agent', 'keyboard-interactive', 'hostbased']`.
         */
        authHandler?: AuthHandlerObject[] | AuthHandlerFunction | AuthHandlerObject['type'][];
        /** Function to be called with detailed (local) debug information */
        debug?(info: string): void;
        /** Only connect via resolved IPv4 address for `host`. */
        forceIPv4?: boolean;
        /** Only connect via resolved IPv6 address for `host`. */
        forceIPv6?: boolean;
        /** Hostname or IP address of the server. Default is `localhost` */
        host?: string;
        /**
         * The host's key is hashed using this method and passed to `hostVerifier`.
         * Supports any valid hashing algorithm that the underlying NodeJS version supports.
         */
        hostHash?: string;
        /** 
         * Function to verify the hex hash of the host's key for verification purposes.
         * Either return a boolean, or call `callback` with a boolean to continue/abort the handshake.
         */
        hostVerifier?: (((hash: string) => boolean) |
            ((hash: string, callback: (success: boolean) => void) => void));
        /** How many consecutive, unanswered SSH-level keepalive packets that can be sent to the server before disconnection. Default is `3` */
        keepaliveCountMax?: number;
        /** How often (in milliseconds) to send SSH-level keepalive packets to the server. Set to `0` to disable */
        keepaliveInterval?: number;
        /** Along with `localUsername` and `privateKey`, set this to a non-empty string for hostbased user authentication */
        localHostname?: string;
        /** Local port number to connect from. Default is 0, as in determined by OS */
        localPort?: number;
        /** Along with `localHostname` and `privateKey`, set this to a non-empty string for hostbased user authentication */
        localUsername?: string;
        /** Passphrase to decrypt the `privateKey` if necessary */
        passphrase?: string;
        /** Password for password-based authentication */
        password?: string;
        /** Port number of the server. Default is `22` */
        port?: number;
        /** Private key for key-based or hostbased authentication (OpenSSH/PPK format) */
        privateKey?: string | Buffer;
        /** How long (in milliseconds) to wait for the SSH handshake to complete. Default is `20000` */
        readyTimeout?: number;
        /** A `ReadableStream` to communicate with the server instead of automatically creating a new TCP connection (useful for connection hopping) */
        sock?: NodeJS.ReadableStream;
        /** Perform strict server vendor check before sending vendor-specific requests, such as `openssh_noMoreSessions`. Enabled by default */
        strictVendor?: boolean;
        /** Try keyboard-interactive user authentication if other authentication methods fail */
        tryKeyboard?: boolean;
        /** Username for authentication */
        username?: string;
    }

    export interface PseudoTtyOptions {
        /** The number of rows. Default is `24` */
        rows: number;
        /** The number of columns. Default is `80` */
        cols: number;
        /** The height in pixels. Default is `480` */
        height: number;
        /** The width in pixels. Default is `640` */
        width: number;
        /** The value to use for `$TERM`. Default is `vt100` */
        term: string;
        /**
         * Object containing Terminal Modes as keys, with each value set to each mode argument.
         * See [the documentation](https://github.com/mscdex/ssh2/tree/master#api) of
         * the version you use to see the list of supported terminal modes.
         */
        modes: Record<string, any> | null;
    }

    export interface X11Options {
        /** Authentication cookie. Either a Buffer or a hex string. Defaults to a random 16 byte value */
        cookie: Buffer | string;
        /** Authentication protocol name. Defaults to `MIT-MAGIC-COOKIE-1` */
        protocol: string;
        /** Screen number to use. Defaults to `0` */
        screen: number;
        /** Whether to only allow a single connection. Allows multiple by default */
        single: boolean;
    }

    /** Used in {@link Client.shell} */
    export interface ShellOptions {
        env?: Record<string, string>;
        /** A {@link PseudoTtyOptions}, `true` for a default pseudo-tty or `undefined` for none */
        pty: Partial<PseudoTtyOptions> | true;
    }

    /** Used in {@link Client.exec} */
    export interface ExecOptions extends ShellOptions {
        /** A {@link X11Options}, `true` for default values or `undefined` for none */
        x11?: Partial<X11Options> | true;
    }

    export type ErrorCallback = (error: Error | undefined) => void;
    export type ClientChannelCallback = (error: Error | undefined, channel: ClientChannel) => void;

    export class Client extends NodeJS.EventEmitter {

        constructor();

        /* METHODS */

        /** Attempts a connection to the server using the given config */
        connect(config: ConnectConfig): void;

        /** Disconnect the socket */
        end(): void;

        /** Executes `command` on the server */
        exec(command: string, callback: ClientChannelCallback): void;
        exec(command: string, options: ExecOptions, callback: ClientChannelCallback): void;

        /** Starts an interactive shell session on the server */
        shell(callback: ClientChannelCallback): void;
        shell(options: ShellOptions, callback: ClientChannelCallback): void;
        shell(pty: Partial<PseudoTtyOptions> | false, callback: ClientChannelCallback): void;
        shell(pty: Partial<PseudoTtyOptions> | false, options: ShellOptions, callback: ClientChannelCallback): void;

        /** Starts an SFTP session. The {@link SFTP} object can be used to perform SFTP operations */
        sftp(callback: (error: Error | undefined, sftp: SFTP) => void): void;

        /** Invokes `subsystem` on the server */
        subsys(subsystem: string, callback: ClientChannelCallback): void;

        /**
         * Bind to `remoteAddr:remotePort` on the server and forward any incoming TCP connections.
         * Listen to the `tcp connection` to accept/reject incoming connections.
         * The callback provides the actual port listened on, handy in case you specified `0`.
         * 
         * @param remoteAddr The remote address to bind to, with the following special values:
         * - An empty string to accept connections on all protocol families supported by the server
         * - `0.0.0.0` to accept connections on all IPv4 addresses
         * - `::` to accept connections on all IPv6 addresses
         * - `localhost` to accept connections on all loopback addresses (any protocol family)
         * - `127.0.0.1` or `::1` for a specific IPv4 or IPv6 loopback addresses
         */
        forwardIn(remoteAddr: string, remotePort: number, callback: (error: Error | undefined, port: number) => void): void;

        /** Method to revert {@link forwardIn}. Use the actual bound port, i.e. not `0` */
        unforwardIn(remoteAddr: string, remotePort: number, callback: ErrorCallback): void;

        /** Opens a connection from the given address/port to the given address/port */
        forwardOut(srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: ClientChannelCallback): void;

        /** OpenSSH extension to listen on UNIX domain sockets, similar to {@link forwardIn} */
        openssh_forwardInStreamLocal(socketPath: string, callback: (error?: Error) => void): void;

        /** OpenSSh extension to revert {@link openssh_forwardInStreamLocal} */
        openssh_unforwardInStreamLocal(socketPath: string, callback: (error?: Error) => void): void;

        /** OpenSSH extension to make a connection to a UNIX domain sockets, similar to {@link forwardOut} */
        openssh_forwardOutStreamLocal(socketPath: string, callback: ClientChannelCallback): void;

        /* OpenSSH extension that sends a request to reject any new sessions */
        openssh_noMoreSessions(callback: (error?: Error) => void): void;

        /** Initiates a rekey with the server */
        rekey(callback?: () => void): void;

        /* EVENTS */

        /** A notice was sent by the server upon connection */
        on(event: 'banner', listener: (message: string, language: string) => void): this;

        /**
            If using password-based user authentication, the server has requested that
            the user's password be changed. Call `done` with the new password.
        */
        on(event: 'change password', listener: (prompt: string, done: (password: string) => void) => void): this;

        /** The socket was closed */
        on(event: 'close', listener: () => void): this;

        /** The socket was disconnected */
        on(event: 'end', listener: () => void): this;

        /**
            An error occured. A `level` property indicates `client-socket` for socket-level errors and
            `client-ssh` for SSH disconnection messages. In the case of `client-ssh` messages, there may
            be a `description` property that provides more detail.
        */
        on(event: 'error', listener: (error: Error & { level?: string; description?: string }) => void): this;

        /** Emitted when an initial or rekey handshake has completed */
        on(event: 'handshake', listener: (negotiated: HandshakeNegotiation) => void): this;

        /** Emitted when the server announces its available host keys */
        on(event: 'hostkeys', listener: (keys: ParsedKey[]) => void): this;

        /** Emitted when the server is asking for replies for `keyboard-interactive` user authentication*/
        on(event: 'keyboard-interactive', listener: KeyboardInteractiveListener): this;

        /** Emitted when authentication was successful */
        on(event: 'ready', listener: () => void): this;

        /** Emitted when a rekeying operation has completed (whether initiated by the client or server) */
        on(event: 'rekey', listener: () => void): this;

        /** An incoming forwarded TCP connection is being requested. Need to call either `accept` or `reject` */
        on(event: 'tcp connection', listener: (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void): this;

        /** An incoming forwarded UNIX connection is being requested. Need to call either `accept` or `reject` */
        on(event: 'unix connection', listener: (details: UnixConnectionDetails, accept: () => ClientChannel, reject: () => void) => void): this;

        /** An incoming X11 connection is being requested. Need to call either `accept` or `reject` */
        on(event: 'x11', listener: (details: X11ConnectionDetails, accept: () => ClientChannel, reject: () => void) => void): this;
    }

    /** Used to create a {@link Server} object */
    export interface ServerConfig {
        /** Explicitly override default transport layer algorithms */
        algorithms?: Algorithms;
        /** Message that is sent to the client immediately, before handshaking behins */
        greeting?: string;
        /** Message that is sent to the client once, right before authentication begins */
        banner?: string;
        /** Function to be called with detailed (local) debug information */
        debug?(info: string): void;
        /** The `highWaterMark` used for the parser stream. Default is `32 * 1024` bytes */
        highWaterMark?: number;
        /** Array of host private keys */
        hostKeys: (Buffer | string | { key: Buffer | string; passphrase?: string })[];
        /** Custom server software name/version identifier. Default is `'ssh2js' + version + 'srv'` */
        ident?: string;
    }

    /** Used by the `authentication` event on {@link Server} */
    // Internally this is an actual class (and so are the inheriting interfaces below) but they aren't exported
    export interface AuthContextBase {
        /** The username the user is try to authenticate with */
        username: string;
        /** Accept the authentication request, marking as and informing the user about being authenticated */
        accept(): void;
        /** Reject the authentication request, and optionally suggest different auth methods and/or specify it was a partial success */
        reject(partialSuccess: boolean): void;
        reject(authMethodsLeft?: AuthContext['method'][], partialSuccess?: boolean): void;

        /** Emitted when the client aborts this authentication request by starting a new one */
        on(event: "abort", listener: () => void): this;
    }

    export interface AuthContextHostBased extends AuthContextBase {
        method: 'hostbased';
        key: {
            /** Key algorithm, such as `ssh-rsa` */
            algo: string;
            /** The public key sent by the client */
            data: Buffer;
        };
        localHostname: string;
        localUsername: string;
        /** Data to be verified, passed (along with `signature`) to `parseKey(key.data).verify` */
        blob: Buffer;
        /** Signature to be verified, passed (along with `blob`) to `parseKey(key.data).verifiy */
        signature: Buffer;
    }

    export interface KeyboardPromptFull {
        /** The prompt text to display to the user */
        prompt: string;
        /** Whether the input should be visible (e.g. `false` for passwords). Default is `false` */
        echo?: boolean;
    }
    /**
     * Either a singular prompt, or a list of prompts.
     * Prompts that are strings are converted to {@link KeyboardPromptFull}s
     * with {@link KeyboardPrompt.echo} set to `true` instead of the usual default of `false`.
     */
    export type KeyboardPrompt = string | KeyboardPromptFull | (string | KeyboardPromptFull)[];
    export interface AuthContextKeyboardInteractive extends AuthContextBase {
        method: 'keyboard-interactive';
        /**
         * Sends prompts to the clients.
         * The callback will be called with a list of answsers for all prompts, in the same order as the prompts.
         * In case this authentication request got aborted, the callback is passed an error instead.
         * String prompts will have {@link KeyboardPrompt.echo} set to `true`.
         */
        prompt(prompts: KeyboardPrompt, callback: (answers: string[] | Error) => void): void;
        prompt(prompts: KeyboardPrompt, title: string, callback: (answers: string[] | Error) => void): void;
        prompt(prompts: KeyboardPrompt, title: string, instructions: string, callback: (answers: string[] | Error) => void): void;
        prompt(prompts: KeyboardPrompt, title: string, instructions: string, callback: (answers: string[] | Error) => void): void;

        prompt(prompts: { prompt: string; echo: boolean }[], instructions: string, callback: (answers: string[]) => void): void;
        /** List of preferred authentication "sub-methods" sent by the client */
        submethods: string[];
    }

    export interface AuthContextPassword extends AuthContextBase {
        method: 'password';
        password: string;
        /** Sends a password change request to the client */
        requestChange(prompt: string, callback: (newPassword: string) => void): void;
    }

    export interface AuthContextPublicKey extends AuthContextBase {
        method: 'publickey';
        key: {
            /** Key algorithm, such as `ssh-rsa` */
            algo: string;
            /** The public key sent by the client */
            data: Buffer;
        };
        /**
         * Data to be verified, which should be passed with `signature` to `parseKey(key.data).verify`.
         * Can be `undefined` if the client is only checking the validity of the public key.
         */
        blob?: Buffer;
        /**
         * Data to be verified, which should be passed with `blob` to `parseKey(key.data).verify`.
         * Can be `undefined` if the client is only checking the validity of the public key.
         */
        signature?: Buffer;
    }

    export type AuthContext = AuthContextHostBased | AuthContextKeyboardInteractive | AuthContextPassword | AuthContextPublicKey;

    /** Used by the `connection` event on {@link Server} */
    export interface ConnectionInfo {
        ip: string;
        family: string;
        port: number;
        /** Information about the client's header */
        header: {
            identRaw: string;
            versions: {
                /** SSH protocol version */
                protocol: '1.99' | '2.0';
                /** Software name and version of the client */
                software: string;
            };
            /** Any text that comes after the software name/version */
            comments: string;
        };
    }

    export interface Channel extends stream.Duplex {
        /**
         * Similar as used in {@link net.Socket}:
         * If set to `true` (the default), and the stream's `end()` is called, only an EOF
         * if sent. The other side of the channel can still send data if they haven't sent EOF yet.
         */
        allowHalfOpen: boolean;

        /** For exec/shell channels, this is a Readable on the client and a Writable on the server*/
        stderr?: stream.Readable | stream.Writable;

        /** Closes the channel */
        close(): void;

        /**
         * Emitted once the channel is completely closed on both the client and server.
         * The exact arguments passed can be the same as `exit` in a ClientChannel but is unclear.
         * Might be arguments from the `close` event emitteed by `stream.Duplex` too, who knows.
         */
        on(event: 'close', listener: () => void): this;

        on(event: string, listener: (...args: any) => void): this;

    }

    export interface ClientChannel extends Channel {

        /** Only available for `exec` and `shell` channels */
        stderr?: stream.Readable | stream.Writable;

        /**
         * Only available for `exec` and `shell` channels.
         * Lets the server know tha tthe local terminal window has been resized.
         */
        setWindow?(rows: number, cols: number, height: number, width: number): void;

        /**
         * Only available for `exec` and `shell` channels.
         * Sends a POSIX signal to the current process on the server.
         * Valid signals are `ABRT`, `ALRM`, `FPE`, `HUP`, `ILL`, `INT`, `KILL`, `PIPE`, `QUIT`, `SEGV`, `TERM`, `USR1`, and `USR2`.
         * 
         * Some server implementations may ignore this request if they do not support signals.
         * If you're trying to send `SIGINT` and you find this method doesn't work, try writing `\x03` to this channel stream.
         */
        signal?(signalName: string): void;

        /**
         * Only available for `exec` channels.
         * An event that *may* be emitted (SSH2 spec says optional) when the process finishes.
         * If it finished normally, the return value is passed. If the process was interrupted by
         * a signal, `null, <signalName>, <didCoreDump>, <description>` are passed instead.
         * If this event got emitted, `close` gets emitted with the same arguments for convenience.
         */
        on(event: 'exit', listener: (status: number | null, signalName?: string, didCoreDump?: boolean, description?: string) => void): this;

        on(event: string, listener: (...args: any) => void): this;
    }

    export interface ServerChannel extends Channel {

        /** Only available for `exec` and `shell` channels */
        stderr?: stream.Writable;

        /** Available for `exec` channels. Can be called right before closing the channel */
        exit?(exitCode: number): void;
        exit?(signalName: string, coreDumped: boolean, errorMsg: string): void;
    }

    export type SessionRequestListener<R = void> = (accept?: () => R, reject?: () => void) => void;
    export type SessionRequestInfoListener<T, R = void> = (
        accept: ((() => R) | undefined),
        reject: ((() => void) | undefined),
        info: T
    ) => void;
    export interface Session extends NodeJS.EventEmitter {

        /** The session was closed */
        on(event: 'close'): this;

        /** The client requested that incoming ssh-agent request be forward to them */
        on(event: 'auth-agent', listener: SessionRequestListener): this;

        /** The client requested an environment variable to be set for this session */
        on(event: 'env', listener: SessionRequestInfoListener<{ key: string; value: string }>): this;

        /** The client requested execution of a command string */
        on(event: 'exec', listener: SessionRequestInfoListener<{ command: string }, Channel>): this;

        /** The client requested allocation of a pseudo-TTY for this session */
        on(event: 'pty', listener: SessionRequestInfoListener<PseudoTtyOptions>): this;

        /** The client requested the SFTP subsystem */
        on(event: 'sftp', listener: SessionRequestListener<SFTP>): this;

        /** The client requested an interactive shell */
        on(event: 'shell', listener: SessionRequestListener<Channel>): this;

        /** The client requested an arbitrary subsystem */
        on(event: 'subsystem', listener: SessionRequestInfoListener<{ name: string }, Channel>): this;

        /** The client requested X11 forwarding */
        on(event: 'x11', listener: SessionRequestInfoListener<X11Options>): this;

        /** The client sent a signal, e.g. `SIGUSR1` */
        on(event: 'signal', listener: SessionRequestInfoListener<{ name: string }>): this;

        /** The client reported a change in window dimensions during this session */
        on(event: 'window-change', listener: SessionRequestInfoListener<
            Pick<PseudoTtyOptions, "cols" | "rows" | "width" | "height">
        >): this;
    }

    export type RequestChannelListener<T> = (accept: () => Channel, reject: () => void, info: T) => void;
    export type ChannelCallback = (error: Error | undefined, channel: Channel) => void;
    export interface Connection extends NodeJS.EventEmitter {

        /** Close the client connection */
        end(): void;

        /** Alert the client of an incoming TCP connection */
        forwardOut(boundAddr: string, boundPort: number, remoteAddr: string, remotePort: number, callback: ChannelCallback): void;

        /** Alert the client of an incoming UNIX domain socket connection */
        openssh_forwardOutStreamLocal(socketPath: string, callback: ChannelCallback): void;

        /** Alert the client of an incoming X11 client connection */
        x11(originAddr: string, originPort: number, callback: ChannelCallback): void;

        /** Initiates a rekey with the client */
        rekey(callback?: () => void): void;

        /** The client has requested authentication. See {@link AuthContext} */
        on(event: 'authentication', listener: (context: AuthContext) => void): this;

        /** Emitted when the client has been successfully authenticated */
        on(event: 'ready', listener: () => void): this;

        /** The client socket was closed */
        on(event: 'close', listener: () => void): this;

        /** The client socket disconnected */
        on(event: 'end', listener: () => void): this;

        /** An error occured */
        on(event: 'error', listener: (error: Error) => void): this;

        /** Emitted when a handshake (initial or rekey) has completed */
        on(event: 'handshake', listener: (handshake: HandshakeNegotiation) => void): this;

        /** Emitted when a rekeying operation has been completed (whether client or server-initiated) */
        on(event: 'rekey', listener: () => void): this;

        on(event: 'request', listener: (
            accept: (((port?: number) => void) | undefined),
            reject: ((() => void) | undefined),
            name: string,
            info: any
        ) => void): this;

        /** Emitted when the client has request a new session. Used to start interactive shells, X11, ... */
        on(event: 'session', listener: (accept: () => Session, reject: () => void) => void): this;

        /** Emitted when the client has requested an outbound TCP connection */
        on(event: 'openssh.streamlocal', listener: RequestChannelListener<TcpConnectionDetails>): this;

        /** Emitted when the client has requested a connection to a UNIX domain socket */
        on(event: 'openssh.streamlocal', listener: RequestChannelListener<UnixConnectionDetails>): this;
    }

    export type ConnectionListener = (client: Connection, info: ConnectionInfo) => void;
    export class Server extends NodeJS.EventEmitter {

        constructor(config: ServerConfig, connectionListener?: ConnectionListener);

        // Methods "inherited" from (internally linked to) {@link net.Server}
        listen: net.Server['listen'];
        close: net.Server['close'];
        address: net.Server['address'];
        getConnections: net.Server['getConnections'];
        ref: net.Server['ref'];
        unref: net.Server['unref'];
        maxConnections: number;

        /**
         * Inject a bidirectional stream as if it were a TCP socket.
         * For best compatibility, should have {@link net.Socket}-like fields such as `remoteAddress`.
         */
        injectSocket(socket: stream.Duplex): void;

        /** A new client has connected (and will soon go through handshaking/authentication) */
        on(event: 'connection', listener: ConnectionListener): this;

        // Events "inherited" from {@link net.Server}
        on(event: "close", listener: () => void): this;
        on(event: "error", listener: (err: Error) => void): this;
        on(event: "listening", listener: () => void): this;
        on(event: string, listener: (...args: any[]) => void): this;

        /**
         * Determines how often we send a ping to the client.
         * Needs to be a finite number above 0 to be enabled.
         * Shared between all servers. Defaults to `15000` milliseconds.
         */
        static KEEPALIVE_CLIENT_INTERVAL: number;
        /**
         * Determines how many unanswered pings we allow in a row before disconnecting the client.
         * Need to be a finite number >=0 to be enabled.
         * Shared between all servers. Defaults to `3`
         */
        static KEEPALIVE_CLIENT_COUNT_MAX: number;
    }

    export namespace utils {
        export { parseKey };
        export namespace sftp {
            export {
                OPEN_MODE,
                STATUS_CODE,
                flagsToString,
                stringToFlags,
            }
        }
    }


}

declare module 'ssh2/lib/protocol/SFTP' {
    import { Channel, Client, ErrorCallback } from 'ssh2';
    import * as stream from 'stream';

    const Handle: unique symbol;
    /** File handles are represented by a Buffer with a special value. Ignore the contents */
    export type Handle = Buffer | Buffer & typeof Handle;

    export interface SFTPOptions {
        /** Whether to read Uint64BE's as BigInts (or only for large numbers). Disabled by default */
        biOpt?: 'always' | 'maybe' | 'never';
        /** Function to be called with detailed (local) debug information */
        debug?(info: string): void;
    }

    /** Used in {@link SFTP.fastGet} */
    export interface FastOptions {
        /** Number of concurrent reads. Default is `64` */
        concurrency?: number;
        /** Size of each read in bytes. Default is `32768` */
        chunkSize?: number;
        /** Called every time a part of a file was transferred */
        step?(totalTransferred: number, chunk: number, total: number): void;
    }

    /** Used in {@link SFTP.fastPut} */
    export interface FastOptionsWithMode extends FastOptions {
        /** File mode to set for the uploaded file */
        mode?: number | string;
    }

    /** Used in {@link SFTP.createWriteStream} */
    export interface WriteStreamOptions {
        /**
         * Flags to open the remote file with:
         * - For {@link SFTP.createReadStream} the default is `r`
         * - For {@link SFTP.createWriteStream} the default is `w`
         * - For {@link SFTP.createWriteStream} you might have to use `r+` to avoid replacing the whole file
         */
        flags?: string;
        encoding?: string | null;
        /** File mode to set for the uploaded file */
        mode?: number | string;
        /** If false, the file handle will never close, even on error. Defaults is `true` */
        autoClose?: boolean;
        /** Start location to read/write to/from. Inclusive and starts at 0 */
        start?: number;
    }

    /** Used in {@link SFTP.createReadStream} */
    export interface ReadStreamOptions extends WriteStreamOptions {
        /** Use an existing handle to read from instead */
        handle?: Handle;
        /** End location to read from. Inclusive and starts at 0 */
        end?: number;
    }

    /** Used in {@link SFTP.readFile} */
    export interface ReadFileOptions {
        /** Flag to open the remote file with. Default is `r` */
        flag?: string;
        /** Encoding if the callback should be passed a string instead of a Buffer. Default is `null` */
        encoding?: string | null;
    }

    /** Used in {@link SFTP.writeFile} */
    export interface WriteFileOptions {
        /** Flag to open the remote file with. Default is `w` (or `a` for {@link SFTP.appendFile}) */
        flag?: string;
        /** Encoding of the data if is a string. Default is `utf8` */
        encoding?: string;
        /** File mode to set for the uploaded file. Default is `0o666` */
        mode?: number | string;
    }

    export interface Attributes {
        /** Mode/permission for the resource */
        mode?: number;
        /** User ID of the resource */
        uid?: number;
        /** Group ID of the resource */
        gid?: number;
        /** Resource size in bytes */
        size?: number;
        /** UNIX timestamp of the access time of the resource */
        atime?: number;
        /** UNIX timestamp of the modified time of the resource */
        mtime?: number;
    }

    export interface Stats extends Attributes {
        isDirectory(): boolean;
        isFile(): boolean;
        isBlockDevice(): boolean;
        isCharacterDevice(): boolean;
        isSymbolicLink(): boolean;
        isFIFO(): boolean;
        isSocket(): boolean;
    }

    export type HandleCallback = (error: Error | undefined, handle: Handle) => void;
    export type StatsCallback = (error: Error | undefined, stats: Stats) => void;

    /** Used in {@link SFTP.attrs} */
    export interface DirectoryEntryPartial {
        filename: string;
        /** `ls -l`-style format, e.g. `-rwxr--r-- 1 bar bar 718 Dec 8 2009 foo` */
        longname: string;
        /** Attributes. Always present from e.g. {@link SFTP.readdir} but optional for {@link SFTP.attrs} */
        attrs?: Attributes;
    }

    /** Used in {@link SFTP.readdir} */
    export interface DirectoryEntry extends DirectoryEntryPartial {
        attrs: Attributes;
    }

    /** Used in {@link SFTP.ext_openssh_statvfs} and {@link SFTP.ext_openssh_fstatvfs} */
    export interface StatsVfs {
        /** File system block size */
        f_bsize: number;
        /** Fundamental fs block size */
        f_frsize: number;
        /** Number of blocks (unit f_frsize) */
        f_blocks: number;
        /** Free blocks in file system */
        f_bfree: number;
        /** Free blocks for unprivileged users */
        f_bavail: number;
        /** Total file inodes */
        f_files: number;
        /** Free file inodes */
        f_ffree: number;
        /** Free file inodes for unprivileged users */
        f_favail: number;
        /** File system id */
        f_sid: number;
        /** Bit mask of f_flag values */
        f_flag: number;
        /** Maximum filename length */
        f_namemax: number;
    }

    /** Can be a drop-in replacement as {@link Channel} */
    export class SFTP extends NodeJS.EventEmitter {

        /**
         * Creates an SFTP object for the given Client/Channel with the given options.
         * Mind that any data this SFTP object tries to send will be sent through the given Channel.
         * On the other hand, this SFTP object doesn't automatically listen. Use {@link push} for that.
         * This SFTP object basically simulates being a Channel, and is meant to replace the given Channel.
         */
        constructor(client: Client, channel: Channel, cfg: SFTPOptions);

        /* CLIENT-ONLY METHODS */

        /** **Client-only**: Downloads a file using parallel reads for faster throughput */
        fastGet(remotePath: string, localPath: string, callback: ErrorCallback): void;
        fastGet(remotePath: string, localPath: string, options: FastOptions, callback: ErrorCallback): void;

        /** **Client-only**: Uploads a file using parallel reads for faster throughput */
        fastPut(localPath: string, remotePath: string, callback: ErrorCallback): void;
        fastPut(localPath: string, remotePath: string, options: FastOptionsWithMode, callback: ErrorCallback): void;

        /** **Client-only**: Creates a readable stream from a remote file */
        createReadStream(path: string, options?: ReadStreamOptions): stream.Readable;

        /** **Client-only**: Creates a writable stream to a remote file */
        createWriteStream(path: string, options?: WriteStreamOptions): stream.Writable;

        /** **Client-only**: Read the data from the remote file at the given path */
        readFile(path: string, options: ReadFileOptions & { encoding: string }, callback: (error: Error | undefined, data: string) => void): void;
        readFile(path: string, options: ReadFileOptions & { encoding?: null }, callback: (error: Error | undefined, data: Buffer) => void): void;
        readFile(path: string, options: ReadFileOptions, callback: (error: Error | undefined, data: Buffer | string) => void): void;
        readFile(path: string, encoding: string, callback: (error: Error | undefined, data: string) => void): void;

        /** **Client-only**: Write the given data to the remote file at the given path */
        writeFile(path: string, data: string | Buffer, callback?: ErrorCallback): void;
        writeFile(path: string, data: string | Buffer, encoding: string, callback?: ErrorCallback): void;
        writeFile(path: string, data: string | Buffer, options: WriteFileOptions, callback?: ErrorCallback): void;

        /** **Client-only**: Appends the given data to the remote file at the given path */
        writeFile(path: string, data: string | Buffer, callback?: ErrorCallback): void;
        writeFile(path: string, data: string | Buffer, encoding: string, callback?: ErrorCallback): void;
        writeFile(path: string, data: string | Buffer, options: WriteFileOptions, callback?: ErrorCallback): void;

        /** **Client-only**: Check whether the given path exists, by checking whether we can {@link stat} it */
        exists(path: string, callback: (exists: boolean) => void): void;

        /** **Client-only**: Opens a remote file. `flags` is any flag supported by `fs.open` except the sync flag */
        open(filename: string, flags: string, attrsMode: Attributes, callback: HandleCallback): void;

        /** **Client-only**: Closes the resource associated with the given handle */
        close(handle: Handle, callback: ErrorCallback): void;

        /** **Client-only**: Reads a chunk of bytes from the given handle and writes it to the given buffer */
        read(handle: Handle, buffer: Buffer, offset: number, length: number, position: number, callback: (
            err: Error | undefined, bytesRead: number,
            /** Mind that the written bytes start at `offset` instead of just `0` */
            buffer: Buffer, position: number) => void): void;

        /** **Client-only**: Writes a chunk of bytes from the given buffer and writes it to the given handle */
        write(handle: Handle, buffer: Buffer, offset: number, length: number, position: number, callback: ErrorCallback): void;

        /** **Client-only**: Retrieves attributes for the resource associated with the given handle */
        fstat(handle: Handle, callback: StatsCallback): void;

        /** **Client-only**: Sets the attributes for the resource associated with the given handle */
        fsetstat(handle: Handle, attributes: Attributes, callback: ErrorCallback): void;

        /** **Client-only**: Sets the access time and modified time for the resource associated with the given handle */
        futimes(handle: Handle, atime: Date | number, mtime: Date | number, callback: ErrorCallback): void;

        /** **Client-only**: Sets the owher for the resource associated with the given handle */
        fchown(handle: Handle, uid: number, gid: number, callback: ErrorCallback): void;

        /** **Client-only**: Sets the mode for the resource associated with the given handle */
        fchmod(handle: Handle, mode: number | string, callback: ErrorCallback): void;

        /** **Client-only**: Opens a directory */
        opendir(path: string, callback: HandleCallback): void;

        /**
         * **Client-only**: Retrieves a directory listing for the given path/handle.
         * If the location is a handle, this function may need to be called multiple times
         * until `list` is `false`, which indicates that no more directory entries are available.
         */
        readdir(location: string, callback: (error: Error | undefined, list: DirectoryEntry[]) => void): void;
        readdir(location: Handle, callback: (error: Error | undefined, list: DirectoryEntry[] | false) => void): void;

        /** **Client-only**: Removes the file/symlink at the given path */
        unlink(path: string, callback: ErrorCallback): void;

        /** **Client-only**: Renames/moves the resource at th egiven path to a new path */
        rename(srcPath: string, destPath: string, callback: ErrorCallback): void;

        /** **Client-only**: Creates a new directory at the given path */
        mkdir(path: string, callback: ErrorCallback): void;
        mkdir(path: string, attrs: Attributes, callback: ErrorCallback): void;

        /** **Client-only**: Removes the directory at the given path */
        rmdir(path: string, callback: ErrorCallback): void;

        /** **Client-only**: Retrieves the attributes for a given path, following symlinks */
        stat(path: string, callback: StatsCallback): void;

        /** **Client-only**: Retrieves the attributes for a given path. If it's a symlink, the stats are for the link itself */
        lstat(path: string, callback: StatsCallback): void;

        /** **Client-only**: Sets the attributes for the given path */
        setstat(path: string, attributes: Attributes, callback: ErrorCallback): void;

        /** **Client-only**: Sets the access time and modified time for the given path */
        utimes(path: string, atime: Date | number, mtime: Date | number, callback: ErrorCallback): void;

        /** **Client-only**: Sets the owher for the given path */
        chown(path: string, uid: number, gid: number, callback: ErrorCallback): void;

        /** **Client-only**: Sets the mode for the given path */
        chmod(path: string, mode: number | string, callback: ErrorCallback): void;

        /** **Client-only**: Retrieves the link target for the given path */
        readlink(path: string, callback: (error: Error | undefined, target: string) => void): void;

        /** **Client-only**: Creates a symlink at the given path to the given target path */
        symlink(targetPath: string, linkPath: string, callback: ErrorCallback): void;

        /** **Client-only**: Resolves the given path to an absolute path */
        realpath(path: string, callback: (error: Error | undefined, absolutePath: string) => void): void;

        /** **Client-only**: OpenSSH extension to perform a POSIX rename(3) operation */
        ext_openssh_rename(srcPath: string, destPath: string, callback: ErrorCallback): void;

        /** **Client-only**: OpenSSH extension to perform a POSIX statvfs(2) operation on the given path */
        ext_openssh_statvfs(path: string, callback: (error: Error | undefined, stats: StatsVfs) => void): void;

        /** **Client-only**: OpenSSH extension to perform a POSIX statvfs(2) operation on the open handle */
        ext_openssh_fstatvfs(handle: Handle, callback: (error: Error | undefined, stats: StatsVfs) => void): void;

        /** **Client-only**: OpenSSH extension to perform a POSIX link(2) to create a hard link */
        ext_openssh_hardlink(targetPath: string, linkPath: string, callback: ErrorCallback): void;

        /** **Client-only**: OpenSSH extension to perform a POSIX fsync(3) on the open handle */
        ext_openssh_fsync(handle: Handle, callback: ErrorCallback): void;

        /** **Client-only**: OpenSSH extension to perform a {@link setstat} but on a symlink itself */
        ext_openssh_lsetstat(path: string, attributes: Attributes, callback: ErrorCallback): void;

        /** **Client-only**: OpenSSH extension to perform a {@link realpath} but with support for tilde-expansion using shell-like rules */
        ext_openssh_expandPath(path: string, callback: (error: Error | undefined, absolutePath: string) => void): void;

        /* CLIENT-ONLY EVENTS */

        /** Emitted after the initial protocol version check has passed */
        on(event: 'ready', listener: () => void): this;

        /* SERVER-ONLY METHODS */

        /** **Server-only**: Send a status response for the request identified by the given id */
        status(reqId: number, statusCode: number, message: string): void;

        /**
         * **Server-only**: Send a handle response for the request identified by the given id.
         * The handle must be less than 256 bytes and is opaque to the user, it only has to be unique.
         */
        handle(reqId: number, handle: Handle): void;

        /** Send a data response for the request identified by the given id */
        data(reqId: number, data: Buffer | string, encoding?: string): void;

        /** Send a name response for the request identified by the given id */
        name(reqId: number, names: DirectoryEntryPartial[]): void;

        /** Send an Attributes response for the request identified by the given id */
        attrs(reqId: number, attributes: Attributes): void;

        /* SERVER-ONLY EVENTS */

        // For these, since it's more if you're creating your own SFTP/SSH server,
        // check https://github.com/mscdex/ssh2/blob/master/SFTP.md#useful-standalone-methods

        on(event: 'OPEN', listener: (reqId: number, filename: string, flags: number, attrs: Attributes) => void): this;
        on(event: 'READ', listener: (reqId: number, handle: Handle, offset: number, length: number) => void): this;
        on(event: 'WRITE', listener: (reqId: number, handle: Handle, offset: number, data: Buffer) => void): this;
        on(event: 'FSTAT', listener: (reqId: number, handle: Handle) => void): this;
        on(event: 'FSETSTAT', listener: (reqId: number, handle: Handle, attrs: Attributes) => void): this;
        on(event: 'CLOSE', listener: (reqId: number, handle: Handle) => void): this;
        on(event: 'OPENDIR', listener: (reqId: number, path: string) => void): this;
        on(event: 'READDIR', listener: (reqId: number, handle: Handle) => void): this;
        on(event: 'LSTAT', listener: (reqId: number, path: string) => void): this;
        on(event: 'STAT', listener: (reqId: number, path: string) => void): this;
        on(event: 'REMOVE', listener: (reqId: number, path: string) => void): this;
        on(event: 'RMDIR', listener: (reqId: number, path: string) => void): this;
        on(event: 'REALPATH', listener: (reqId: number, path: string) => void): this;
        on(event: 'READLINK', listener: (reqId: number, path: string) => void): this;
        on(event: 'SETSTAT', listener: (reqId: number, path: string, attrs: Attributes) => void): this;
        on(event: 'MKDIR', listener: (reqId: number, path: string, attrs: Attributes) => void): this;
        on(event: 'RENAME', listener: (reqId: number, oldPath: string, newPath: string) => void): this;
        on(event: 'SYMLINK', listener: (reqId: number, linkPath: string, targetPath: string) => void): this;

        /* GENERAL */

        /** Closes the underlying Channel object, thus ending this SFTP connection */
        destroy(): void;

        /** Alias for {@link destroy} */
        end(): void;

        /** **Internal**: Sends the INIT request (with client version). Becomes a NOOP after first use */
        _init(): void;

        /** **Internal**: Used to deliver data into the SFTP object */
        push(data: Buffer): void;

        /** Emitted when the SFTP stream/channel has ended */
        on(event: 'end', listener: () => void): this;
    }

    /** Contains various open file flags */
    export namespace OPEN_MODE {
        export const READ = 0x00000001;
        export const WRITE = 0x00000002;
        export const APPEND = 0x00000004;
        export const CREAT = 0x00000008;
        export const TRUNC = 0x00000010;
        export const EXCL = 0x00000020;
    }

    /** Contains various status codes (for use especially with {@link SFTP.status}) */
    export namespace STATUS_CODE {
        export const OK = 0;
        export const EOF = 1;
        export const NO_SUCH_FILE = 2;
        export const PERMISSION_DENIED = 3;
        export const FAILURE = 4;
        export const BAD_MESSAGE = 5;
        export const NO_CONNECTION = 6;
        export const CONNECTION_LOST = 7;
        export const OP_UNSUPPORTED = 8;
    }

    /** Converts a flag mask (e.g. a number containing `OPEN_MODE` values) to a string */
    export function flagsToString(flagsMask: number): string | null;

    /** Converts string flags (e.g. `r+`, `a+`, etc) to the appropriate `OPEN_MODE` mask */
    export function stringToFlags(flagsStr: string): number | null;
}

declare module 'ssh2/lib/agent' {
    import { Client, ConnectConfig } from 'ssh2';
    import { ParsedKey } from 'ssh2/lib/protocol/keyParser';
    import * as stream from 'stream';

    // Prevent the `Client` import from being organized away, as we use it below in a TSDoc comment
    type _Client = Client & ConnectConfig;

    // Export AgentProtocol, BaseAgent, createAgent, CygwinAgent, OpenSSHAgent, PageantAgent

    export interface SignOptions {
        /** The explicitly desired hash algorithm, e.g. `sha256` or `sha512` for RSA keys */
        hash: string;
    }

    export class AgentProtocol extends stream.Duplex {

        constructor(isClient: boolean);

        /** **Server-only**: Reply to the given `request` with a failure response */
        failureReply(request: any): void;

        /** **Client-only**: Request a list of public keys from the agent */
        getIdentities(callback: (err: Error | undefined, keys: Buffer[]) => void): void;

        /** **Server--only**: Respond to an `identities` event's `request` */
        getIdentitiesReply(request: any, keys: Buffer[]): void;

        /** **Client-only**: Request that the agent signs the given data */
        sign(pubKey: Buffer | string | ParsedKey, data: Buffer, options: SignOptions, callback: (err: Error | undefined, signature: Buffer) => void): void;

        /** **Server-only**: Respond to an `sign` event's `request` */
        signReply(request: any, signature: Buffer): void;

        /**
         * **Server-only**:
         * Emitted when the client requests a list of public keys stored in the agent.
         * Use {@link failureReply} or {@link getIdentitiesReply} to reply appropriately.
         */
        on(event: 'identities', listener: (request: any) => void): this;

        /**
         * **Client-only**:
         * Emitted when the client requests data to be signed.
         * Use {@link failureReply} or {@link signReply} to reply appropriately.
         */
        on(event: 'sign', listener: (request: any, pubKey: Buffer | string | ParsedKey, data: Buffer, options: SignOptions) => void): this;

        on(event: string, listener: (...args: any[]) => void): this;
    }

    /** See [documentation](https://github.com/mscdex/ssh2/tree/master#baseagent) of the used version */
    export abstract class BaseAgent {

        getIdentities(callback: (err: Error | undefined, keys: Buffer[]) => void): void;

        sign(pubKey: Buffer | string | ParsedKey, data: Buffer, options: SignOptions, callback: (err: Error | undefined, signature: Buffer) => void): void;

        getStream?(callback: (err: Error | undefined, stream: stream.Duplex) => void): void;
    }

    /**
     * Creates and returns a new agent instance using the same logic as what {@link Client} uses
     * internally for {@link ConnectConfig.agent}:
     * - On Windows with `pageant` as value it creates a {@link PageantAgent}
     * - On Windows with a non-pipe it creates a {@link CygwinAgent}
     * - In all other cases it creates a {@link OpenSSHAgent}
     */
    export function createAgent(agentValue: string): BaseAgent;

    /** Communicates with a UNIX domain socket in a Cygwin environment */
    export class CygwinAgent extends BaseAgent {
        constructor(socketPath: string);
    }

    /** Communicates with an OpenSSH listening on a UNIX domain socket or Windows named pipe */
    export class OpenSSHAgent extends BaseAgent {
        constructor(socketPath: string);
    }

    /** Communicates with a running Pageant agent process on Windows */
    export class PageantAgent extends BaseAgent { }
}

declare module 'ssh2/lib/protocol/keyParser' {
    type InputData = string | Buffer | NodeJS.ArrayBufferView;
    export interface ParsedKey {
        /** Key type, such as `ssh-rsa`, `ecdsa-sha2-nistp256`, ... */
        type: string;
        /** Key comment. Can be an empty string (e.g. old OpenSSH format) */
        comment: string;
        sign(data: InputData, algo?: string): Buffer | Error;
        verify(data: InputData, signature: InputData, algo?: string): boolean | Error;
        isPrivateKey(): boolean;
        getPrivatePEM(): string;
        getPublicPEM(): string;
        getPublicSSH(): Buffer;
        equals(parsedKey: ParsedKey): boolean;
    }


    export function isParsedKey(key: any): key is ParsedKey;
    /**
     * Supported key types (differs per key format):
     * - `ssh-rsa`
     * - `ssh-dss`
     * - `ecdsa-sha2-nistp256`
     * - `ecdsa-sha2-nistp384`
     * - `ecdsa-sha2-nistp521`
     * - `ssh-ed25519` (depending on platform support)
     * 
     * Supported key formats:
     * - OpenSSH Private (v1) (will return a single key)
     * - OpenSSH Private (old format) (will return a single key)
     * - OpenSSH Public (will return a single key)
     * - RFC4716 Public (will return a single key)
     * - Putty PPK (will return a single key)
     * 
     * And yes, this function can **return** an Error **and** throw one!
     */
    export function parseKey(keyData: ParsedKey | Buffer | string, passphrase?: string | Buffer): ParsedKey | Error;
}
