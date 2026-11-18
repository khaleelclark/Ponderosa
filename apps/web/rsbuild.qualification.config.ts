// Private diagnostic build only. Keep production optimization and add attribution maps.
import { mergeRsbuildConfig } from "@rsbuild/core";
import config from "./rsbuild.config";
export default mergeRsbuildConfig(config, { output: { sourceMap: { js: "source-map" } } });
