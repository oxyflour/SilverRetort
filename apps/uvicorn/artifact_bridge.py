"""Serve the artifact iframe bridge from uvicorn-owned preview origins."""

from pathlib import Path

from fastapi.responses import FileResponse, Response

BRIDGE_SCRIPT = r'''(function () {
  "use strict";

  var port = null;
  var pending = new Map();
  var readyResolve;
  var ready = new Promise(function (resolve) {
    readyResolve = resolve;
  });

  function makeRequestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function handleAck(event) {
    var message = event.data;
    if (
      !message ||
      message.type !== "silverretort.host.ack" ||
      message.version !== 1 ||
      typeof message.requestId !== "string"
    ) {
      return;
    }

    var request = pending.get(message.requestId);
    if (!request) {
      return;
    }
    pending.delete(message.requestId);

    if (message.status === "saved") {
      request.resolve({
        status: message.status,
        revision: message.revision,
      });
      return;
    }
    request.reject(new Error(message.error || "Artifact submission rejected."));
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (
      event.source !== window.parent ||
      !message ||
      message.type !== "silverretort.artifact.init" ||
      message.version !== 1 ||
      event.ports.length !== 1
    ) {
      return;
    }

    if (port) {
      port.close();
    }
    port = event.ports[0];
    port.onmessage = handleAck;
    port.start();
    readyResolve();
    window.dispatchEvent(new CustomEvent("silverretort:ready"));
  });

  function setContext(action, data, options) {
    if (typeof action !== "string" || !action.trim()) {
      return Promise.reject(new TypeError("action must be a non-empty string"));
    }

    return ready.then(function () {
      return new Promise(function (resolve, reject) {
        var requestId = makeRequestId();
        pending.set(requestId, { resolve: resolve, reject: reject });
        port.postMessage({
          type: "silverretort.artifact.context",
          version: 1,
          requestId: requestId,
          action: action,
          data: data === undefined ? null : data,
          displayText:
            options && typeof options.displayText === "string"
              ? options.displayText
              : undefined,
        });
      });
    });
  }

  Object.defineProperty(window, "silverRetort", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: Object.freeze({
      ready: ready,
      setContext: setContext,
      submit: setContext,
    }),
  });
})();
'''


def artifact_bridge_response():
    source = Path(__file__).resolve().parent.parent / "next" / "public" / "artifact-bridge-v1.js"
    if source.is_file():
        return FileResponse(source, media_type="text/javascript; charset=utf-8")
    return Response(BRIDGE_SCRIPT, media_type="text/javascript; charset=utf-8")
