import type { IncomingMessage } from "node:http";

/** Vercel Blob addresses look like https://<store>.public.blob.vercel-storage.com/... */
export const isBlobUrl = (u?: string | null): boolean => !!u && /^https:\/\/[^/]+\.public\.blob\.vercel-storage\.com\//.test(u);

export async function removeBlob(url: string): Promise<void> {
  const { del } = await import("@vercel/blob");
  await del(url);
}

const TYPES = ["video/mp4", "video/webm", "video/x-matroska", "video/quicktime"];

/** Hands the browser a short-lived token to upload one video straight to Vercel Blob. */
export async function handleBlobUpload(body: any, request: IncomingMessage, authorize: (clientPayload: string | null) => void): Promise<unknown> {
  const { handleUpload } = await import("@vercel/blob/client");
  return handleUpload({
    body,
    request,
    onBeforeGenerateToken: async (_pathname, clientPayload) => {
      authorize(clientPayload);
      return { allowedContentTypes: TYPES, maximumSizeInBytes: 5 * 1024 ** 3, addRandomSuffix: true };
    },
    // The page saves the finished address itself (PATCH sourceUrl), so nothing to do here.
    onUploadCompleted: async () => {},
  });
}
