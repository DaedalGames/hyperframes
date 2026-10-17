// Builds one S3 object from others in order with UploadPartCopy, so no byte passes through the
// function. S3 requires every part but the last to be at least 5 MiB.

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  type S3Client,
  UploadPartCopyCommand,
} from "@aws-sdk/client-s3";
import { parseS3Uri } from "./s3Transport.js";

export const MIN_PART_BYTES = 5 * 1024 * 1024;

export interface StitchSource {
  uri: string;
  size: number;
}

/** `false` when a source other than the last is under 5 MiB, which S3 rejects as a part. */
export function canCopyAsParts(sources: readonly StitchSource[]): boolean {
  return sources.every(
    (source, index) => index === sources.length - 1 || source.size >= MIN_PART_BYTES,
  );
}

export async function headObjectSizes(
  s3: S3Client,
  uris: readonly string[],
): Promise<StitchSource[]> {
  return Promise.all(
    uris.map(async (uri) => {
      const { bucket, key } = parseS3Uri(uri);
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (typeof head.ContentLength !== "number") throw new Error(`[s3Stitch] no size for ${uri}`);
      return { uri, size: head.ContentLength };
    }),
  );
}

type UploadTarget = { Bucket: string; Key: string; UploadId: string };

async function copyPart(s3: S3Client, uri: string, partNumber: number, target: UploadTarget) {
  const source = parseS3Uri(uri);
  const result = await s3.send(
    new UploadPartCopyCommand({
      ...target,
      PartNumber: partNumber,
      CopySource: encodeURI(`${source.bucket}/${source.key}`),
    }),
  );
  const etag = result.CopyPartResult?.ETag;
  if (!etag) throw new Error(`[s3Stitch] part ${partNumber} returned no ETag`);
  return etag;
}

/** Settles every copy before failing, so an abort never races a copy still in flight. */
async function copyParts(s3: S3Client, uris: readonly string[], target: UploadTarget) {
  const settled = await Promise.allSettled(
    uris.map((uri, index) => copyPart(s3, uri, index + 1, target)),
  );
  const failure = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<string>).value);
}

/** Copy the objects at `uris` into `destUri` in order; a failed stitch aborts the upload so no parts linger. */
export async function stitchS3Objects(
  s3: S3Client,
  uris: readonly string[],
  destUri: string,
  contentType: string,
): Promise<void> {
  const { bucket, key } = parseS3Uri(destUri);
  const created = await s3.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  );
  if (!created.UploadId) throw new Error(`[s3Stitch] no upload id for ${destUri}`);
  const target = { Bucket: bucket, Key: key, UploadId: created.UploadId };
  try {
    const etags = await copyParts(s3, uris, target);
    await s3.send(
      new CompleteMultipartUploadCommand({
        ...target,
        MultipartUpload: { Parts: etags.map((ETag, index) => ({ ETag, PartNumber: index + 1 })) },
      }),
    );
  } catch (error) {
    await s3.send(new AbortMultipartUploadCommand(target)).catch((abortError: unknown) => {
      console.error(
        `[s3Stitch] abort failed for ${destUri}; parts remain until a lifecycle rule removes them`,
        abortError,
      );
    });
    throw error;
  }
}
