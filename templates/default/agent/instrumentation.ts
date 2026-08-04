import { OTLPHttpJsonTraceExporter, registerOTel } from "@vercel/otel";
import { defineInstrumentation } from "eve/instrumentation";

/**
 * Ships traces to the evestack dashboard.
 *
 * A TRADE-OFF WORTH KNOWING: the mere existence of this file disables eve's
 * zero-config local trace spool (`.eve/traces/v1`), which is what `eve traces`
 * reads. eve hands control to authored instrumentation and does not install its
 * own writer alongside it. Delete this file to get `eve traces` back.
 *
 * That is an acceptable trade here because the dashboard supersedes the spool:
 * it keeps history past the spool's bounded retention (7 days / 512 MB / 20
 * traces), and it survives `eve dev` exiting.
 *
 * JSON, not protobuf: the dashboard's ingest route parses OTLP/HTTP JSON, so
 * OTLPHttpProtoTraceExporter — the exporter eve's own `instrumentation/jaeger`
 * registry item uses — would post bytes the endpoint cannot read.
 *
 * With EVESTACK_DASHBOARD_URL unset we register nothing, so an agent running
 * without the dashboard pays no exporter cost and fails no exports.
 */
const endpoint = process.env.EVESTACK_DASHBOARD_URL;

export default defineInstrumentation({
  setup: ({ agentName }) => {
    if (!endpoint) return;
    registerOTel({
      serviceName: agentName,
      traceExporter: new OTLPHttpJsonTraceExporter({ url: endpoint }),
    });
  },
  // Prompts and tool results are the reason to open a trace at all — without
  // them the dashboard can show that a turn happened but not what it did.
  // Set both false for sensitive or regulated data.
  recordInputs: process.env.EVESTACK_TRACE_CONTENT !== "off",
  recordOutputs: process.env.EVESTACK_TRACE_CONTENT !== "off",
});
