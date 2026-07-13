/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["desktop/dist/**/*"],
  },
};
export default nextConfig;
