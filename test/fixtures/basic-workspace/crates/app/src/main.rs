fn main() {
    println!("{}", probe_core::add(1, 2));
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_adds() {
        assert_eq!(probe_core::add(1, 2), 3);
    }
}
