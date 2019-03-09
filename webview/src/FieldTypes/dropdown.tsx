import * as React from 'react';
import { FieldBase } from './base';

interface Props<T> {
    values: T[];
    displayName?(item: T): string;
    displayStyle?(item: T): React.CSSProperties;
}
interface State<T> {
    open: boolean;
}
export class FieldDropdown<T> extends FieldBase<T, Props<T>, State<T>> {
    public mainDivRef = React.createRef<HTMLDivElement>();
    public componentDidMount() {
        window.addEventListener('click', this.onGlobalClick);
    }
    public componentWillUnmount() {
        window.removeEventListener('click', this.onGlobalClick);
    }
    public getInitialSubState(props: Props<T>): State<T> {
        return { open: false };
    }
    public renderInput() {
        const { newValue, open } = this.state;
        const { displayName } = this.props;
        const display = newValue ? (displayName ? displayName(newValue) : newValue.toString()) : '';
        return <div className="FieldDropdown" ref={this.mainDivRef}>
            <p style={{ float: 'right', margin: 5 }}>▼</p>
            <div className="current" onClick={this.toggle}>{display}</div>
            {open && this.generateDropdown()}
        </div>;
    }
    public generateDropdown() {
        const { displayName, displayStyle, values } = this.props;
        const generateItem = (item: T, index: number) => {
            const style = displayStyle && displayStyle(item);
            return <li key={index} style={style} onClick={this.select.bind(this, item)}>
                {displayName ? displayName(item) : item.toString()}
            </li>
        };
        return <ul className="list">{values.map(generateItem)}</ul>;
    }
    public select(newValue: T) {
        this.setState({ newValue, open: false }, () => this.props.onChange(newValue));
    }
    public toggle = () => this.setState({ open: !this.state.open });
    public onGlobalClick = (event: MouseEvent) => {
        if (!this.state.open) return;
        if (event.composedPath().includes(this.mainDivRef.current!)) return;
        this.toggle();
    };
}