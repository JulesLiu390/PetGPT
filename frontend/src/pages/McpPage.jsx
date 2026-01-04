import React from "react";
import McpTitleBar from "../components/Layout/McpTitleBar";
import McpSettings from "../components/Settings/McpSettings";
import { PageLayout } from "../components/UI/ui";

/**
 * MCP 服务器管理页面
 */
const McpPage = () => {
  return (
    <PageLayout className="bg-white/95">
      <div className="h-screen flex flex-col overflow-hidden">
        {/* 标题栏 */}
        <div className="sticky top-0 z-10">
          <McpTitleBar />
        </div>
        
        {/* MCP 设置内容 */}
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          <McpSettings />
        </div>
      </div>
    </PageLayout>
  );
};

export default McpPage;
