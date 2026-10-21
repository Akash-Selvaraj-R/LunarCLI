import { ToolRegistry } from './registry.js'
import { fileExistsTool, listDirectoryTool, readFileTool } from './filesystem.js'
import { findFilesTool, searchFilesTool } from './search.js'
import { gitBranchTool, gitDiffTool, gitLogTool, gitStatusTool } from './git-tools.js'

/**
 * The Phase 2 tool set.
 *
 * filesystem: list_directory, read_file, file_exists
 * search:     search_files, find_files
 * git:        git_status, git_diff, git_log, git_branch
 *
 * Nothing else is registered. There is no shell tool, no file-mutation
 * tool, and no git-mutation tool in this registry — the model can only
 * request what exists here, and unregistered names are refused by the
 * executor as unknown tools.
 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register(listDirectoryTool)
  registry.register(readFileTool)
  registry.register(fileExistsTool)
  registry.register(searchFilesTool)
  registry.register(findFilesTool)
  registry.register(gitStatusTool)
  registry.register(gitDiffTool)
  registry.register(gitLogTool)
  registry.register(gitBranchTool)
  return registry
}
