import { FileSystemConfig, formatConfigLocation } from 'common/fileSystemConfig';
import { connect } from '../redux';
import type { Props as FieldBaseProps } from './base';
import { FieldDropdown, Props as FieldDropdownProps } from './dropdown';

type Props = Omit<FieldBaseProps<FileSystemConfig>, 'value'> & FieldDropdownProps<FileSystemConfig> & {
    /**
     * Defaults to `'full'`. Determines how `values` and the default `displayName`.
     * In which way to display configs in the dropdown and how to handle duplicate:
     * - `full`: Display `<label || name> - <location>`, no duplicate handling.
     * - `names`: Display label/name. Keep first config in case of duplicate names.
     */
    type?: 'full' | 'names';
    /** Value can be a config name. First matching config will be picked, otherwise `undefined`. */
    value?: FileSystemConfig | string;
};

const DISPLAY_NAME: Record<NonNullable<Props['type']>, (config: FileSystemConfig) => string> = {
    full: config => `${config.label || config.name} - ${formatConfigLocation(config._location)}`,
    names: config => config.label || config.name,
};

export const FieldConfig = connect(({ type = 'full', value, values, ...props }: Props) => {
    if (type === 'names') {
        const seen = new Set<string>();
        values = values.filter(({ name }) => seen.has(name) ? false : seen.add(name));
    }
    if (typeof value === 'string') value = values.find(({ name }) => name === value);
    return <FieldDropdown displayName={DISPLAY_NAME[type]} {...props} value={value} values={values} />;
})<Pick<Props, 'values'>>(state => ({ values: state.data.configs }));
