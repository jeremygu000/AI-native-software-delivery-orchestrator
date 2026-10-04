export const supportsCodingTui = (
  version: string,
  arguments_: readonly string[],
  nodeOptions = ''
): boolean => {
  const [major, minor] = version.split('.').map(Number);
  const supportedVersion =
    major !== undefined && minor !== undefined && (major > 26 || (major === 26 && minor >= 4));
  const ffi =
    arguments_.includes('--experimental-ffi') ||
    /(?:^|\s)--experimental-ffi(?:\s|$)/.test(nodeOptions);
  return supportedVersion && ffi;
};
