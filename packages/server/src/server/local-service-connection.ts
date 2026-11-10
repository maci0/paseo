import http from "node:http";
import net from "node:net";
import { requireNodeOnly } from "./node-only-require.js";

interface LoopbackAddress {
  address: string;
  family: number;
}

// A host can support IPv6 loopback without listing ::1 for localhost in DNS.
// Typed by hand: scriptc has no lowering for net.LookupFunction or dns.LookupOptions.
function lookupLoopback(
  _hostname: string,
  _options: unknown,
  callback: (error: null, addresses: LoopbackAddress[]) => void,
): void {
  callback(null, [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ]);
}

type LocalServiceRequestOptions = Pick<http.RequestOptions, "port" | "path" | "method" | "headers">;

interface LoopbackRequestOptions extends LocalServiceRequestOptions {
  hostname: string;
  autoSelectFamily: boolean;
  lookup: typeof lookupLoopback;
}

type LoopbackRequest = (
  options: LoopbackRequestOptions,
  onResponse: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

// scriptc's http.request takes neither `lookup` nor `autoSelectFamily` (SC2020, SC0001), so
// Node loads its own http.request through requireNodeOnly, which scriptc leaves to run time
// and only Node runs. A scriptc binary reports
// process.argv[0] as "scriptc".
function loadNodeHttpRequest(): LoopbackRequest {
  const loaded = requireNodeOnly("node:http") as { request: LoopbackRequest };
  return loaded.request;
}

const nodeHttpRequest = process.argv[0] === "scriptc" ? undefined : loadNodeHttpRequest();

export function connectToLocalService(port: number): net.Socket {
  return net.connect({ host: "localhost", port, autoSelectFamily: true, lookup: lookupLoopback });
}

export function requestLocalService(
  options: LocalServiceRequestOptions,
  onResponse: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  if (nodeHttpRequest === undefined) {
    // Native builds resolve localhost to 127.0.0.1 only: a service listening only on ::1
    // is not reached.
    return http.request(
      {
        hostname: "localhost",
        port: options.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
      },
      onResponse,
    );
  }
  const requestOptions = {
    ...options,
    hostname: "localhost",
    autoSelectFamily: true,
    lookup: lookupLoopback,
  };
  return nodeHttpRequest(requestOptions, onResponse);
}
