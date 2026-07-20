module.exports = function (api) {
  api.cache(true);
  // babel-preset-expo (SDK 57) handles expo-router and reanimated/worklets.
  return { presets: ['babel-preset-expo'] };
};
