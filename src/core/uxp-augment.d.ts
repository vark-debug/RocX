/**
 * UXP 模块类型增强（runtime 真实存在但 type 定义不完整）
 */
declare module "uxp" {
  // storage 命名空间实际还包含 localFileSystem（运行时真实存在但 types 中未声明）
  namespace storage {
    const localFileSystem: {
      getDataFolder(): Promise<any>;
      getPluginFolder(): Promise<any>;
      getTemporaryFolder(): Promise<any>;
      getFolder(options?: { initialDomain?: symbol }): Promise<any>;
      getFileForOpening(options?: {
        allowMultiple?: boolean;
        types?: Array<{ name?: string; extensions?: string[] }>;
        initialLocation?: any;
      }): Promise<any>;
      getEntryWithUrl(url: string): Promise<any>;
      createEntryWithUrl(
        url: string,
        options?: { type?: any; overwrite?: boolean },
      ): Promise<any>;
      getNativePath(entry: any): string;
      getFsUrl(entry: any): string;
    };
  }
}

export {};