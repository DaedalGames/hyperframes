import { describe, expect, it } from "vitest";
import { VideoSourceExtractionError } from "../services/videoFrameExtractor.js";
import { redactUrlQueriesInError, urlInputArgs } from "./urlInput.js";

const signed =
  "https://bucket.s3.us-east-2.amazonaws.com/a/b?X-Amz-Credential=AKID&X-Amz-Signature=deadbeef";

describe("urlInputArgs", () => {
  it("makes ffmpeg verify the certificate of an https input against a CA bundle", () => {
    expect(urlInputArgs(signed, ["/nonexistent.crt", import.meta.filename])).toEqual([
      "-tls_verify",
      "1",
      "-ca_file",
      import.meta.filename,
    ]);
  });

  it("adds nothing for local paths and plain http", () => {
    expect(urlInputArgs("/plan/compiled/bg.mp4", [])).toEqual([]);
    expect(urlInputArgs("http://127.0.0.1:8080/bg.mp4", [])).toEqual([]);
  });

  it("refuses an https input when no CA bundle exists", () => {
    expect(() => urlInputArgs(signed, ["/nonexistent.crt"])).toThrow(/no CA bundle/);
  });
});

describe("redactUrlQueriesInError", () => {
  it("strips a signed URL's query from the message, diagnostic and stack", () => {
    const error = redactUrlQueriesInError(
      new VideoSourceExtractionError("ffmpeg_failed", false, `read ${signed}`, `${signed}: 403`),
    );
    for (const text of [error.message, error.diagnostic, error.stack]) {
      expect(text).toContain("https://bucket.s3.us-east-2.amazonaws.com/a/b?");
      expect(text).not.toContain("deadbeef");
    }
  });
});
