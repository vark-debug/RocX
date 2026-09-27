/**
 * 通用 provider 错误（替代 MiniMax.ts 中的 MiniMaxError）
 */
export class VideoGenError extends Error {
  httpStatus?: number;
  errorType?: string;
  requestId?: string;
  providerId?: string;

  constructor(
    message: string,
    opts: {
      httpStatus?: number;
      errorType?: string;
      requestId?: string;
      providerId?: string;
    } = {},
  ) {
    super(message);
    this.name = "VideoGenError";
    this.httpStatus = opts.httpStatus;
    this.errorType = opts.errorType;
    this.requestId = opts.requestId;
    this.providerId = opts.providerId;
  }
}