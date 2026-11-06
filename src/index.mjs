// 公共入口：把这个"调度内核"的可复用面集中导出。
//
// 用法（库）：
//   import { JOBS, runMain, dshHome, LOCK_REGISTRY } from '@kira905/dsh-butler-engine';
// 用法（命令行）：butler-tickd --list / --status / --once
//
// 说明：本包的调度表本身（JOBS）是常量数组，改它需要改源码 —— 这是**故意的**：
//   「谁能自己上班」这件事应当被 diff 审一遍，而不是悄悄写进某个配置文件。
export { JOBS, TICKD_VERSION, hasLiveChild, runMain } from './dsh-butler/butler-tickd.mjs';

export {
  COMPONENT_ROOT, dshHome, butlerPaths, statePath, ensureDir, realOrResolve, monthKey, newRunId,
} from './dsh-butler/lib/paths.mjs';

export {
  isModuleEnabled, readJobSwitches, declaredJobDefault, isTickJobEnabled, setJobEnabled, describeJobs,
} from './dsh-butler/lib/autonomy-modules.mjs';

export {
  BUTLER_LOCKS_VERSION, LOCK_REGISTRY, canonicalJobId, lockEntryFor, lockNameFor,
  lockEntryByName, jobsForLock, ownerOf, usesLockRunner, lockRunnerJobIds,
  mustYieldInHandoff, describeLockTable, heldLockNames,
} from './dsh-butler/lib/butler-locks.mjs';

export {
  StoreError, SchemaMismatchError, AtomicWriteError, LockTimeoutError,
  writeTextAtomic, writeJsonAtomic, appendJsonl, readJson, updateJson,
  acquireRmwLock, acquireTickLock, renewTickLock, sweepStaleTickLocks,
} from './dsh-butler/lib/store.mjs';

export { alert } from './dsh-butler/lib/alert.mjs';
export { appendAudit } from './dsh-butler/lib/audit.mjs';
