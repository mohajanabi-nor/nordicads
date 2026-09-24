/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Build with one worker. The parallel default is what kept crashing the dev
    // server here ("Jest worker encountered 2 child process exceptions"), and a
    // slower build is a fair trade for one that finishes.
    //
    // `workerThreads: true` belongs with this and must NOT come back: it moves
    // page generation into a thread that never receives Next's internal
    // revalidation address, so the build fails at "Generating static pages"
    // with `Failed to parse URL from http://localhost:undefined`. Compilation
    // succeeds first, which makes it look like a late, unrelated failure.
    cpus: 1,
  },
};

export default nextConfig;
