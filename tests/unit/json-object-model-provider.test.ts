import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelRetryAdviceRequest,
  StreamEvent,
} from "@openai/agents";

import { createJsonObjectModelProvider } from "../../src/agents/providers/create-json-object-model-provider.js";

function structuredRequest(): ModelRequest {
  return {
    input: "perform the task",
    modelSettings: {},
    tools: [],
    handoffs: [],
    outputType: {
      type: "json_schema",
      name: "actor_output",
      strict: true,
      schema: {
        type: "object",
        properties: {
          output: { type: "string" },
          outcome: { type: "string" },
        },
        required: ["output", "outcome"],
        additionalProperties: false,
      },
    },
    tracing: false,
  };
}

function emptyResponse(): ModelResponse {
  return {
    output: [],
    usage: {
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  } as unknown as ModelResponse;
}

class RecordingModel implements Model {
  public readonly responseRequests: ModelRequest[] = [];
  public readonly streamRequests: ModelRequest[] = [];
  public readonly retryRequests: ModelRetryAdviceRequest[] = [];

  public async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.responseRequests.push(request);
    return emptyResponse();
  }

  public async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    this.streamRequests.push(request);
  }

  public getRetryAdvice(request: ModelRetryAdviceRequest) {
    this.retryRequests.push(request);
    return { suggested: false, reason: "delegate decision" };
  }
}

class RecordingProvider implements ModelProvider {
  public readonly model = new RecordingModel();
  public requestedModelName: string | undefined;

  public getModel(modelName?: string): Model {
    this.requestedModelName = modelName;
    return this.model;
  }
}

test("rewrites structured response requests without mutating the original", async () => {
  const delegate = new RecordingProvider();
  const provider = createJsonObjectModelProvider(delegate);
  const model = await provider.getModel("deepseek-v4-flash");
  const request = structuredRequest();

  await model.getResponse(request);

  assert.equal(delegate.requestedModelName, "deepseek-v4-flash");
  assert.notEqual(request.outputType, "text");
  if (request.outputType === "text") assert.fail("Expected structured output");
  assert.equal(request.outputType.type, "json_schema");
  assert.notEqual(delegate.model.responseRequests[0], request);
  assert.deepEqual(delegate.model.responseRequests[0]?.outputType, {
    type: "json_object",
  });
});

test("preserves the schema as final-output instructions for JSON Object mode", async () => {
  const delegate = new RecordingProvider();
  const provider = createJsonObjectModelProvider(delegate);
  const model = await provider.getModel("deepseek-v4-flash");
  const request = {
    ...structuredRequest(),
    systemInstructions: "Keep the existing actor instructions.",
  };

  await model.getResponse(request);

  const forwarded = delegate.model.responseRequests[0];
  assert.equal(request.systemInstructions, "Keep the existing actor instructions.");
  assert.match(
    forwarded?.systemInstructions ?? "",
    /Keep the existing actor instructions\./,
  );
  assert.match(forwarded?.systemInstructions ?? "", /Return only one JSON object/);
  assert.match(
    forwarded?.systemInstructions ?? "",
    /Tool calls take priority over final JSON output/,
  );
  assert.match(forwarded?.systemInstructions ?? "", /"output"/);
  assert.match(forwarded?.systemInstructions ?? "", /"outcome"/);
  assert.match(
    forwarded?.systemInstructions ?? "",
    /\{"output":"useful action result","outcome":"succeeded"\}/,
  );
});

test("rewrites streamed structured requests through the same compatibility path", async () => {
  const delegate = new RecordingProvider();
  const provider = createJsonObjectModelProvider(delegate);
  const model = await provider.getModel("deepseek-v4-flash");
  const request = structuredRequest();

  for await (const _event of model.getStreamedResponse(request)) {
    assert.fail("The recording model should not emit stream events");
  }

  assert.notEqual(request.outputType, "text");
  if (request.outputType === "text") assert.fail("Expected structured output");
  assert.equal(request.outputType.type, "json_schema");
  assert.deepEqual(delegate.model.streamRequests[0]?.outputType, {
    type: "json_object",
  });
});

test("passes text requests and retry advice through unchanged", async () => {
  const delegate = new RecordingProvider();
  const provider = createJsonObjectModelProvider(delegate);
  const model = await provider.getModel("deepseek-v4-flash");
  const request = { ...structuredRequest(), outputType: "text" as const };
  const retryRequest: ModelRetryAdviceRequest = {
    request,
    error: new Error("rate limited"),
    stream: false,
    attempt: 1,
  };

  await model.getResponse(request);
  const advice = await model.getRetryAdvice?.(retryRequest);

  assert.equal(delegate.model.responseRequests[0], request);
  assert.equal(delegate.model.retryRequests[0], retryRequest);
  assert.deepEqual(advice, {
    suggested: false,
    reason: "delegate decision",
  });
});
