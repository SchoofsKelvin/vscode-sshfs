import { FieldBase } from './base';

const PERM_MAP: Record<number, string> = {
    0: '---',
    1: '--x',
    2: '-w-',
    3: '-wx',
    4: 'r--',
    5: 'r-x',
    6: 'rw-',
    7: 'rwx',
};

export class FieldUmask extends FieldBase<number | undefined> {
    protected getValueClassName() {
        return super.getValueClassName() + ' checkbox-box checkbox-small';
    }
    public renderInput() {
        const value = this.getValue() || 0;
        console.log(this.state.newValue, '=>', value);
        const cell = (target: number, permission: number) => {
            const shifted = permission * target;
            const checked = (value & shifted) > 0;
            return <td className="checkbox">
                <div className="checkbox-box">
                    <div className={`checkbox ${checked ? 'checked' : ''}`}
                        onClick={() => this.setPart(shifted, !checked)} />
                </div>
            </td>;
        };
        const row = (target: number, name: string) => <tr>
            <th scope="row">{name}</th>
            {cell(target, 4)}
            {cell(target, 2)}
            {cell(target, 1)}
        </tr>;
        return <>
            <table>
                <tbody>
                    <tr><th /><th>Read</th><th>Write</th><th>Execute</th></tr>
                    {row(0o100, 'Owner')}
                    {row(0o010, 'Group')}
                    {row(0o001, 'Other')}
                </tbody>
            </table>
            <span>
                Resulting mask:{" "}
                <code>
                    {PERM_MAP[(value / 0o100) & 0o7]}
                    {PERM_MAP[(value / 0o010) & 0o7]}
                    {PERM_MAP[(value / 0o001) & 0o7]}
                </code>
            </span>
        </>;
    }
    public getError() {
        const { newValue } = this.state;
        const { validator, optional } = this.props;
        if (newValue === undefined) {
            if (optional) return null;
            return 'No value given';
        } else if (Number.isNaN(Number(newValue))) {
            return 'Not a number';
        }
        return validator ? validator(newValue!) : null;
    }
    public getValue(): number | undefined {
        const { newValue, oldValue } = this.state;
        if (newValue === undefined) {
            return this.props.optional ? newValue : Number(oldValue);
        }
        return typeof newValue === 'number' ? newValue : (Number(newValue) || undefined);
    }
    public setPart(part: number, checked: boolean): void {
        this.setState(({ newValue }) => ({
            newValue: checked ? (newValue || 0) | part : (newValue || 0) & ~part
        }), () => this.props.onChange(this.getValue()));
    }
}