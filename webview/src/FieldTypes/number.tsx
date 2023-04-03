import * as React from 'react';
import { FieldBase } from './base';

export class FieldNumber extends FieldBase<number> {
    public renderInput() {
        return <input value={this.state.newValue} onChange={this.onChangeEvent} type="number" />;
    }
    public getError() {
        const { newValue } = this.state;
        const { validator, optional } = this.props;
        if (newValue === undefined) {
            if (optional) return null;
            return 'No value given';
        } else if (!Number(newValue)) {
            return 'Not a number';
        }
        return validator ? validator(newValue!) : null;
    }
    public getValue(): number | undefined {
        const { newValue, oldValue } = this.state;
        if (newValue === undefined) {
            return this.props.optional ? newValue : Number(oldValue);
        }
        return Number(newValue) || undefined;
    }
    public onChange = (newValue?: number) => {
        newValue = Number(newValue) || undefined;
        this.setState({ newValue }, () => this.props.onChange(newValue));
    }
    public onChangeEvent = (event: React.ChangeEvent<HTMLInputElement>) => {
        this.onChange(event.target.value as any || undefined);
    }
}