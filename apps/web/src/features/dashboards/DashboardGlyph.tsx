// SPDX-License-Identifier: AGPL-3.0-only
import { Icon } from '../../lib/icons';

/** The dashboard glyph (sidebar row, page header, empty state): four tiles of different heights. */
export const DashboardGlyph = ({ size = 15 }: { size?: number }) => <Icon name="dashboard" size={size} />;
