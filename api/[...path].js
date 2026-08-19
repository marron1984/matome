import { createServerlessHandler } from '../src/serverless.js';

// Vercelのサーバレス関数エントリポイント。
// 静的ファイル（public/）はCDNが返すので、ここではAPIだけを扱う。
export default createServerlessHandler();
