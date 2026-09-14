// The managed Windows runner can fail libuv's account lookup with ENOMEM.
// tsx only needs a stable username to name its cache directory, so provide a
// deterministic fallback while preserving the native result where available.
const os = require("node:os");
const nativeUserInfo = os.userInfo;

os.userInfo = (...args) => {
  try {
    return nativeUserInfo(...args);
  } catch (error) {
    if (error?.code !== "ERR_SYSTEM_ERROR") throw error;
    return {
      uid: -1,
      gid: -1,
      username: process.env.USERNAME || "warehouse-agent",
      homedir: process.env.USERPROFILE || process.cwd(),
      shell: null,
    };
  }
};
