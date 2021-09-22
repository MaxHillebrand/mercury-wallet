# Mercury Wallet

Mercury wallet is a cross-platform GUI for [Mercury](https://github.com/commerceblock/mercury) written in node.js using Electron.

# Configuration

Custom configurations can be set in `/src/settings.json` in JSON format:

| Name                    | Type    | Default                                                                 |
| ----------------------- | ------- | ----------------------------------------------------------------------- |
| state_entity_endpoint   | string  | http://pslackfq3eiuk5pckcykldunuuyzhe3lcbrtqp6kl36e37lwrgbzurad.onion   |
| swap_conductor_endpoint | string  | http://pslackfq3eiuk5pckcykldunuuyzhe3lcbrtqp6kl36e37lwrgbzurad.onion   |
| electrum_config         | object  | { host: 'https://explorer.blockstream.com/testnet/api', port: null, protocol: 'http'}        |
| tor_proxy               | object  | { ip: 'localhost', port: 9060, controlPassword: '', controlPort: 9061 } |
| min_anon_set            | number  | 5                                                                       |
| notifications           | boolean | true                                                                    |
| tutorials               | boolean | false                                                                   |
| testing_mode            | boolean | false                                                                   |

In electrum_config, the protocol options are 'http' or 'wss'. http routes the connection via TOR and the 'port' should normally be set to 'null'. 

# Development instructions

## Run development

`yarn install`

`yarn run dev`

### Using a local mercury server and mock tor adapter

When running in development mode, a mock tor adapter can be used - the connection will not be done via a tor circuit - this allows connection to a mercury server on localhost. To use the mock tor adapter edit tor-adapter/server/settings.json and change the tor-proxy ip to 'mock' as in the following example:

`"tor_proxy": {"ip": "mock"}`

## Run tests

### Unit tests

`yarn run test`

### End to end tests

`yarn run e2e`

## Testing mode

Setting testing_mode removes some inconveniences to make testing easier and faster:

-   No seed confirmation
-   Electrum calls mocked so no need to send and wait for funding transactions

## Rust bindings

Cryptographic functions and protocols are written in Rust. The required individual functions
are wrapped and compiled to WebAssembly.

`client-wasm/src` contains the Rust code and `client-wasm/pkg` the built WebAssembly.

To rebuild after editing:

`yarn run build-wasm`

`yarn upgrade client_wasm`

Mac users may have to compile WebAssembly from within a Docker container:

## Docker instructions for building client-wasm

There is a DockerFile in `client-wasm/`, first build the image

`cd client-wasm`

`docker build -t rustwasm .`

Run container with

`docker run --rm -it -v ${PWD}:/code rustwasm bash`

To build wasm:

`cd /code`

`wasm-pack build`

You can edit files outside of container with your normal text editor and then
issue cargo/wasm build in container again.

## Connecting via a tor node

Configure the tor proxy settings either in the settings.json file as described above if running in develop mode, or using the "settings" page in the app. Click "save" in order for the settings to take effect.

The API calls will be routed via the tor node if a .onion address is used as the state entity or swap protocol endpoint. A new tor circuit will be obtained after each API call.

## Logs

Logs are written to console and file at the following locations:

-   on Linux: ~/.config/{app name}/logs/{process type}.log
-   on macOS: ~/Library/Logs/{app name}/{process type}.log
-   on Windows: %USERPROFILE%\AppData\Roaming\{app name}\logs\{process type}.log

# Contact

If you have any further questions you can find us at:

# Issue Tracker

# License

Mercury Wallet is released under the terms of the GNU General Public License. See for more information https://opensource.org/licenses/GPL-3.0
