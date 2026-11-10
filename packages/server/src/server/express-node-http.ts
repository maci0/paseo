import type { IncomingMessage, ServerResponse } from "node:http";
import type { Request, Response } from "express";

// The node:http objects behind an express request and response, for code that
// needs them as such (an upstream response piped back, the MCP transport).
// Real express subclasses IncomingMessage and ServerResponse, so under Node
// these return their argument. Native scriptc builds map "express" to
// native/express, whose Request and Response hold the node:http objects in
// `raw`, because scriptc can neither subclass the node:http classes nor pipe
// an IncomingMessage into anything but a ServerResponse, ClientRequest or
// Socket. Each function type checks against both: with real express the
// `raw` branch is never taken, with native/express the other branch is
// `never`. The check is the runtime, not `"raw" in res`, which scriptc does
// not compile on a Writable subclass.

const WRAPPED = process.argv[0] === "scriptc";

interface WrappedRequest {
  readonly raw: IncomingMessage;
}

interface WrappedResponse {
  readonly raw: ServerResponse;
}

function isWrappedRequest(_req: Request): _req is Request & WrappedRequest {
  return WRAPPED;
}

function isWrappedResponse(_res: Response): _res is Response & WrappedResponse {
  return WRAPPED;
}

export function nodeRequest(req: Request): IncomingMessage {
  return isWrappedRequest(req) ? req.raw : req;
}

export function nodeResponse(res: Response): ServerResponse {
  return isWrappedResponse(res) ? res.raw : res;
}
