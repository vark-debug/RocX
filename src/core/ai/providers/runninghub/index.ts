/**
 * RunningHub UXP provider 注册（import 副作用完成注册）
 */
import { registerUxPProvider } from "../registry";
import { RunningHubUxPProvider } from "./RunningHubUxPProvider";

export const runningHubUxPProvider = new RunningHubUxPProvider();

registerUxPProvider(runningHubUxPProvider);
