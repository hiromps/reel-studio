// 案件一覧の出し分け。投稿し終えて「隠す」にした案件を既定では出さない（DOM に触らないのでテストできる）。
//
// 決め事:
// - 隠した案件も**消えてはいない**。表示に切り替えれば戻り、いつでも「一覧に戻す」で元の扱いになる
// - **いま開いている案件だけは、隠していても必ず出す**。開いたまま隠したときに一覧から消えると、
//   開いているのに切り替えも戻しもできない行き止まりになる
// - 表示するときも、隠した案件は下にまとめる（進行中の案件を上に保つ）
import type {ProjectInfo} from '../api';

type Archivable = Pick<ProjectInfo, 'archivedAt'>;

export const isArchived = (p: Archivable): boolean => !!p.archivedAt;

export const archivedCount = (projects: Archivable[]): number => projects.filter(isArchived).length;

/** 一覧（と上部の案件選択）に出す案件を、出す順に返す */
export const visibleProjects = <T extends Archivable & Pick<ProjectInfo, 'slug'>>(projects: T[], opt: {active: string | null; showArchived: boolean}): T[] =>
  projects.filter((p) => opt.showArchived || !isArchived(p) || p.slug === opt.active).sort((a, b) => Number(isArchived(a)) - Number(isArchived(b)));
