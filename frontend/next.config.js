/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for @ricky0123/vad-web ONNX runtime WASM files
  webpack: (config) => {
    config.resolve.extensions.push(".ts", ".tsx");
    // Allow WASM loading for VAD library
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};

module.exports = nextConfig;
