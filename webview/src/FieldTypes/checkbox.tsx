import { FieldBase } from './base';

interface Props {
    optional?: false;
}
export class FieldCheckbox extends FieldBase<boolean, Props> {
    protected getClassName() {
        return super.getClassName() + ' FieldCheckbox';
    }
    protected getValueClassName() {
        return super.getValueClassName() + ' checkbox-box';
    }
    public renderInput() {
        const { description } = this.props;
        return <>
            <div className={`checkbox ${this.getValue() ? 'checked' : ''}`} onClick={this.onClick} />
            {description && <div className="description">{this.props.description}</div>}
        </>;
    }
    public getError() {
        const { newValue } = this.state;
        const { validator, optional } = this.props;
        if (newValue === undefined) {
            if (optional) return null;
            return 'No value given';
        } else if (typeof newValue !== 'boolean') {
            return 'Not a boolean';
        }
        return validator ? validator(newValue!) : null;
    }
    public getValue(): boolean | undefined {
        const { newValue, oldValue } = this.state;
        if (newValue === undefined) {
            return this.props.optional ? newValue : oldValue;
        }
        return newValue;
    }
    public onChange = (newValue?: boolean) => {
        this.setState({ newValue }, () => this.props.onChange(newValue));
    }
    public onClick = () => this.onChange(!this.getValue());
}