import { describe, expect, it } from "bun:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { MIN_PART_BYTES, canCopyAsParts, stitchS3Objects } from "./s3Stitch.js";

const MiB = 1024 * 1024;

describe("canCopyAsParts", () => {
  it("allows a small last piece", () => {
    expect(
      canCopyAsParts([
        { uri: "s3://b/c/0.mp4", size: 120 * MiB },
        { uri: "s3://b/c/1.mp4", size: MIN_PART_BYTES },
        { uri: "s3://b/c/2.mp4", size: 1 },
      ]),
    ).toBe(true);
  });

  it("refuses when a piece other than the last is under 5 MiB", () => {
    expect(
      canCopyAsParts([
        { uri: "s3://b/c/0.mp4", size: 120 * MiB },
        { uri: "s3://b/c/1.mp4", size: MIN_PART_BYTES - 1 },
        { uri: "s3://b/c/2.mp4", size: 120 * MiB },
      ]),
    ).toBe(false);
  });
});

class RecordingS3 {
  readonly sent: { name: string; input: Record<string, unknown> }[] = [];
  constructor(private readonly failPart?: number) {}
  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    this.sent.push({ name, input: command.input });
    if (name === "CreateMultipartUploadCommand") return { UploadId: "up-1" };
    if (name === "UploadPartCopyCommand") {
      if (command.input.PartNumber === this.failPart) throw new Error("copy failed");
      return { CopyPartResult: { ETag: `"etag-${command.input.PartNumber}"` } };
    }
    return {};
  }
  asClient(): S3Client {
    return this as unknown as S3Client;
  }
}

describe("stitchS3Objects", () => {
  const uris = ["s3://bucket/r/chunks/0000.mp4", "s3://bucket/r/chunks/0001.mp4"];

  it("copies every part and completes them in order", async () => {
    const s3 = new RecordingS3();
    await stitchS3Objects(s3.asClient(), uris, "s3://bucket/r/output.mp4", "video/mp4");
    const copies = s3.sent.filter((c) => c.name === "UploadPartCopyCommand").map((c) => c.input);
    expect(copies.map((c) => [c.PartNumber, c.CopySource])).toEqual([
      [1, "bucket/r/chunks/0000.mp4"],
      [2, "bucket/r/chunks/0001.mp4"],
    ]);
    const complete = s3.sent.find((c) => c.name === "CompleteMultipartUploadCommand")!.input;
    expect(complete.MultipartUpload).toEqual({
      Parts: [
        { ETag: '"etag-1"', PartNumber: 1 },
        { ETag: '"etag-2"', PartNumber: 2 },
      ],
    });
    expect(s3.sent.some((c) => c.name === "AbortMultipartUploadCommand")).toBe(false);
  });

  it("aborts the upload when a part copy fails", async () => {
    const s3 = new RecordingS3(2);
    await expect(
      stitchS3Objects(s3.asClient(), uris, "s3://bucket/r/output.mp4", "video/mp4"),
    ).rejects.toThrow("copy failed");
    expect(s3.sent.at(-1)).toEqual({
      name: "AbortMultipartUploadCommand",
      input: { Bucket: "bucket", Key: "r/output.mp4", UploadId: "up-1" },
    });
    expect(s3.sent.some((c) => c.name === "CompleteMultipartUploadCommand")).toBe(false);
  });
});
