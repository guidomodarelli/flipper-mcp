import RWS from 'reconnecting-websocket';

/*
 * reconnecting-websocket 4.4.0 ships `module.exports = Class` but types it as
 * `export default class`. Under NodeNext the default import is the class at
 * runtime and the namespace at type level, so re-type it once here.
 */
export const ReconnectingWebSocket = RWS as unknown as typeof RWS.default;
export type ReconnectingWebSocket = InstanceType<typeof ReconnectingWebSocket>;
